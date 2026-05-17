const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
const app = express();
const dns = require('dns');
const port = process.env.PORT || 5000;
const crypto = require('crypto');

function generateTrackingId() {
    const prefix = 'PRCL';
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${date}-${random}`;
}

const stripe = require('stripe')(process.env.STRIPE);
dns.setServers(['1.1.1.1', '8.8.8.8']);

app.use(cors(
    {
        origin: [
            "http://localhost:3000",
            "https://parcel-managment-web.vercel.app"
        ],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        credentials: true
    }))
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGO_URI || `mongodb+srv://${process.env.USER_NAME}:${process.env.PASSWORD}@cluster0.kwkb8qp.mongodb.net/?appName=Cluster0`;

if (!uri) {
    throw new Error('MongoDB connection string is missing. Set MONGO_URI or USER_NAME and PASSWORD.');
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Global collections (will be set after MongoDB connects)
let ParcelCollection, PaymentCollection, UsersCollection, RiderCollection, SupportCollection;
let dbConnected = false;

// Middleware to ensure DB is connected before handling requests
const ensureDbConnected = async (req, res, next) => {
    if (!dbConnected) {
        try {
            await client.connect();
            ParcelCollection = client.db("ZapshiptDB").collection("parcels");
            PaymentCollection = client.db("ZapshiptDB").collection("payment");
            UsersCollection = client.db("ZapshiptDB").collection("Users");
            RiderCollection = client.db("ZapshiptDB").collection("Rider");
            SupportCollection = client.db("ZapshiptDB").collection("support_messages");
            dbConnected = true;
            await client.db("admin").command({ ping: 1 });
            console.log("Successfully connected to MongoDB!");
        } catch (error) {
            console.error("Error connecting to MongoDB:", error);
            return res.status(500).send({ error: 'Database connection failed' });
        }
    }
    next();
};

app.use(ensureDbConnected);

// ========== PARCELS API ==========
app.post('/parcels', async (req, res) => {
    try {
        const parcel = req.body;
        const result = await ParcelCollection.insertOne(parcel);
        res.send(result);
    } catch (error) {
        console.error('Error creating parcel:', error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/parcels', async (req, res) => {
    try {
        const query = {};
        const { email, deliverystatus, riderEmail } = req.query;

        if (email) {
            query.senderEmail = email;
        }

        if (riderEmail) {
            query.riderEmail = riderEmail;
        }

        if (deliverystatus === 'pending-pickup') {
            query.deliverystatus = {
                $in: ['pending-pickup', 'assigned']
            };
        }

        if (deliverystatus === 'assigned') {
            query.deliverystatus = {
                $in: ['assigned']
            };
        }

        const parcels = await ParcelCollection.find(query).toArray();
        res.send(parcels);
    } catch (error) {
        console.error('Error fetching parcels:', error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/admin/parcels/all', async (req, res) => {
    try {
        const parcels = await ParcelCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.send(parcels);
    } catch (error) {
        console.error('Error fetching admin parcels:', error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/admin/dashboard/stats', async (req, res) => {
    try {
        const allParcels = await ParcelCollection.find({}).toArray();

        const delivered = allParcels.filter(p => p.deliverystatus === 'delivered').length;
        const pending = allParcels.filter(p => p.deliverystatus === 'pending-pickup' || p.deliverystatus === 'assigned').length;
        const totalRevenue = allParcels.reduce((sum, p) => sum + (p.totalPrice || 0), 0);
        const activeDeliveries = allParcels.filter(p =>
            p.deliverystatus === 'pending-pickup' ||
            p.deliverystatus === 'assigned' ||
            p.deliverystatus === 'picked-up'
        ).length;
        const totalUsers = await UsersCollection.countDocuments();
        const totalRiders = await RiderCollection.countDocuments({ status: 'approved' });

        res.send({
            totalParcels: allParcels.length,
            deliveredParcels: delivered,
            pendingParcels: pending,
            totalRevenue: totalRevenue,
            totalUsers: totalUsers,
            activeDeliveries: activeDeliveries,
            totalRiders: totalRiders
        });
    } catch (error) {
        console.error('Error fetching admin stats:', error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/parcels/:id', async (req, res) => {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };
    const parcel = await ParcelCollection.findOne(query);
    res.send(parcel);
});

app.delete('/parcels/:id', async (req, res) => {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };
    const result = await ParcelCollection.deleteOne(query);
    res.send(result);
});

app.put('/parcels/:id', async (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;
    const filter = { _id: new ObjectId(id) };
    delete updatedData.senderName;
    delete updatedData.senderEmail;
    delete updatedData.status;
    const updateDoc = {
        $set: {
            ...updatedData
        }
    };
    const result = await ParcelCollection.updateOne(filter, updateDoc);
    res.send(result);
});

app.patch('/parcels/:id', async (req, res) => {
    const { riderId, riderName, riderEmail, riderPhone, parentId, deliverystatus, assignedAt } = req.body;
    const id = req.params.id;
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
        $set: {
            deliverystatus: deliverystatus || 'assigned',
            riderId,
            riderName,
            riderEmail,
            riderPhone,
            parentId,
            assignedAt: assignedAt || new Date()
        }
    };
    const result = await ParcelCollection.updateOne(filter, updateDoc);

    if (riderId) {
        await RiderCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { workstatus: 'in-delivery' } }
        );
    }

    res.send(result);
});

app.patch('/parcels/deliverystatus/:id', async (req, res) => {
    try {
        const { deliverystatus, acceptedBy, rejectedBy, rejectionReason, pickedUpBy, deliveredBy } = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const currentParcel = await ParcelCollection.findOne(filter);

        const updateDoc = {
            $set: {
                deliverystatus: deliverystatus,
                updatedAt: new Date()
            }
        };

        if (deliverystatus === 'accepted') {
            updateDoc.$set.acceptedAt = new Date();
            updateDoc.$set.acceptedBy = acceptedBy;
        }

        if (deliverystatus === 'picked-up') {
            updateDoc.$set.pickedUpAt = new Date();
            updateDoc.$set.pickedUpBy = pickedUpBy;
        }

        if (deliverystatus === 'delivered') {
            updateDoc.$set.deliveredAt = new Date();
            updateDoc.$set.deliveredBy = deliveredBy;

            if (currentParcel?.riderId) {
                await RiderCollection.updateOne(
                    { _id: new ObjectId(currentParcel.riderId) },
                    { $set: { workstatus: 'available' } }
                );
            }
        }

        if (deliverystatus === 'pending-pickup') {
            updateDoc.$set.rejectedAt = new Date();
            updateDoc.$set.rejectedBy = rejectedBy;
            updateDoc.$set.rejectionReason = rejectionReason || 'No reason provided';

            if (currentParcel?.riderId) {
                await RiderCollection.updateOne(
                    { _id: new ObjectId(currentParcel.riderId) },
                    { $set: { workstatus: 'available' } }
                );
            }

            updateDoc.$set.riderId = null;
            updateDoc.$set.riderName = null;
            updateDoc.$set.riderEmail = null;
            updateDoc.$set.riderPhone = null;
        }

        const result = await ParcelCollection.updateOne(filter, updateDoc);
        res.send(result);
    } catch (error) {
        console.error('Error updating parcel status:', error);
        res.status(500).send({ error: error.message });
    }
});

// PAYMENT API
app.post('/create-payment-intent', async (req, res) => {
    const payInfo = req.body;
    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: 'USD',
                    unit_amount: parseInt(payInfo.totalPrice) * 100,
                    product_data: {
                        name: payInfo.parcelName,
                    }
                },
                quantity: 1,
            },
        ],
        customer_email: payInfo.email,
        mode: 'payment',
        metadata: {
            parcelId: payInfo.parcelId,
            parcelName: payInfo.parcelName,
        },
        success_url: `${process.env.STRIPE_DOMAIN}/dashboard/paymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_DOMAIN}/dashboard/paymentCancel`,
    });

    res.send({ url: session.url });
});

app.patch('/paymentSuccess', async (req, res) => {
    try {
        const { sessionId } = req.body;

        console.log('Received sessionId:', sessionId);

        if (!sessionId) {
            return res.status(400).send({ error: 'Session ID required' });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log('Session payment status:', session.payment_status);
        console.log('Session metadata:', session.metadata);

        if (session.payment_status !== 'paid') {
            return res.status(400).send({ error: 'Payment not completed' });
        }

        const transactionId = session.payment_intent;
        const query = { transactionId: transactionId };
        const paymentExist = await PaymentCollection.findOne(query);

        if (paymentExist) {
            return res.send({
                transactionId: paymentExist.transactionId,
                trackingId: paymentExist.trackingId
            });
        }

        const trackingId = generateTrackingId();
        const parcelId = session.metadata.parcelId;

        if (!parcelId) {
            return res.status(400).send({ error: 'Parcel ID not found in session metadata' });
        }

        const updateQuery = { _id: new ObjectId(parcelId) };
        const updateDoc = {
            $set: {
                status: 'paid',
                paymentStatus: 'completed',
                paidAt: new Date(),
                trackingId: trackingId,
                transactionId: transactionId,
                deliverystatus: 'pending-pickup'
            }
        };

        const result = await ParcelCollection.updateOne(updateQuery, updateDoc);
        console.log('Update result:', result);

        if (result.modifiedCount === 0) {
            return res.status(404).send({ error: 'Parcel not found or already updated' });
        }

        const payment = {
            amount: session.amount_total / 100,
            currency: session.currency,
            paymentMethod: session.payment_method_types?.[0] || 'card',
            paidAt: new Date(),
            customer_email: session.customer_details?.email || session.customer_email,
            parcelId: parcelId,
            parcelName: session.metadata.parcelName,
            transactionId: transactionId,
            paymentStatus: session.payment_status,
            trackingId: trackingId
        };

        const resultPayment = await PaymentCollection.insertOne(payment);

        res.send({
            success: true,
            trackingId: trackingId,
            transactionId: transactionId,
            paymentId: resultPayment.insertedId
        });

    } catch (error) {
        console.error('Error in paymentSuccess:', error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/payment', async (req, res) => {
    const { email } = req.query;
    const query = {};

    if (email) {
        query.customer_email = email;
    }

    // Remove the decoded_email check since we don't have authentication
    const result = await PaymentCollection.find(query).toArray();
    res.send(result);
});

// USERS API
app.post('/users', async (req, res) => {
    const user = req.body;

    const existingUser = await UsersCollection.findOne({ email: user.email });

    if (existingUser) {
        return res.send({ message: "User already exists" });
    }

    user.role = "user";
    user.createAt = new Date();

    const result = await UsersCollection.insertOne(user);
    res.send(result);
});

app.get('/users', async (req, res) => {
    const result = await UsersCollection.find().toArray();
    res.send(result);
});

app.patch('/users/:id', async (req, res) => {
    const { id } = req.params;
    const role = req.body.role;
    const filter = { _id: new ObjectId(id) };
    const updatedDoc = {
        $set: {
            role: role
        }
    };
    const result = await UsersCollection.updateOne(filter, updatedDoc);
    res.send(result);
});

app.delete('/users/:id', async (req, res) => {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };
    const result = await UsersCollection.deleteOne(query);
    res.send(result);
});

app.get('/users/:email/role', async (req, res) => {
    const email = req.params.email;
    const query = { email: email };
    const user = await UsersCollection.findOne(query);
    res.send({ role: user?.role || 'user' });
});

// RIDER API
app.post('/rider', async (req, res) => {
    try {
        const rider = req.body;
        const email = rider.email;
        const existingApplication = await RiderCollection.findOne({
            email: email,
            status: { $in: ['approved', 'pending'] }
        });

        if (existingApplication) {
            return res.status(400).json({
                message: `You already have a ${existingApplication.status} application. ${existingApplication.status === 'approved'
                    ? 'You are already a rider.'
                    : 'Please wait for review.'
                    }`
            });
        }

        const rejectedApplication = await RiderCollection.findOne({
            email: email,
            status: 'rejected'
        });

        if (rejectedApplication) {
            rider.status = "pending";
            rider.createAt = new Date();
            const result = await RiderCollection.updateOne(
                { _id: rejectedApplication._id },
                { $set: rider }
            );
            return res.send(result);
        }

        rider.status = "pending";
        rider.createAt = new Date();
        const result = await RiderCollection.insertOne(rider);
        res.send(result);

    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.get('/rider', async (req, res) => {
    const query = {};
    if (req.query.status) {
        query.status = req.query.status;
    }
    if (req.query.district) {
        query.district = req.query.district;
    }
    if (req.query.workstatus) {
        query.workstatus = req.query.workstatus;
    }
    console.log('Rider query:', query);
    const result = await RiderCollection.find(query).toArray();
    console.log('Rider results:', result.length);
    res.send(result);
});

app.get('/rider/check-application/:email', async (req, res) => {
    try {
        const email = req.params.email;
        const existingApplication = await RiderCollection.findOne({ email: email });

        if (existingApplication) {
            res.send({
                hasApplied: true,
                status: existingApplication.status,
                application: existingApplication
            });
        } else {
            res.send({
                hasApplied: false,
                status: null
            });
        }
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.patch('/rider/:id', async (req, res) => {
    try {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const rider = await RiderCollection.findOne(query);

        if (!rider) {
            return res.status(404).send({ message: "Rider not found" });
        }

        const updateStatus = {
            $set: {
                status: status,
                workstatus: 'available'
            }
        };

        if (status === "approved") {
            const userEmail = rider.email;
            const userQuery = { email: userEmail };
            const updateUser = {
                $set: {
                    role: "rider"
                }
            };

            const userResult = await UsersCollection.updateOne(userQuery, updateUser);
            console.log("User role updated:", userResult);

            if (userResult.matchedCount === 0) {
                console.log("User not found in UsersCollection with email:", userEmail);
            }
        }

        const result = await RiderCollection.updateOne(query, updateStatus);

        res.send({
            success: true,
            riderUpdate: result,
            message: status === "approved" ? "Rider approved and role updated" : "Rider rejected"
        });

    } catch (error) {
        console.error("Error updating rider:", error);
        res.status(500).send({
            success: false,
            message: "Failed to update rider status",
            error: error.message
        });
    }
});

// SUPPORT API
app.get('/support/messages', async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).send({ message: 'Email query parameter is required' });
        }

        const messages = await SupportCollection.find({ email: email })
            .sort({ createdAt: -1 })
            .toArray();

        res.send(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/admin/support/messages', async (req, res) => {
    try {
        const { adminEmail } = req.query;
        const user = await UsersCollection.findOne({ email: adminEmail });

        if (user?.role !== 'admin') {
            return res.status(403).send({ message: 'Admin access required' });
        }

        const messages = await SupportCollection.find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.send(messages);
    } catch (error) {
        console.error("Error fetching all messages:", error);
        res.status(500).send({ error: error.message });
    }
});

app.post('/support/messages', async (req, res) => {
    try {
        const { subject, message, name, role, email } = req.body;

        if (!subject || !message || !email) {
            return res.status(400).send({ error: 'Subject, message, and email are required' });
        }

        const newMessage = {
            _id: new ObjectId(),
            email: email,
            name: name || email.split('@')[0],
            role: role || 'user',
            subject: subject,
            message: message,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            replies: []
        };

        const result = await SupportCollection.insertOne(newMessage);
        res.status(201).send({ ...newMessage, _id: result.insertedId });
    } catch (error) {
        console.error("Error creating message:", error);
        res.status(500).send({ error: error.message });
    }
});

app.post('/support/messages/:id/reply', async (req, res) => {
    try {
        const { id } = req.params;
        const { message, repliedByName, repliedByRole, repliedBy } = req.body;

        if (!message) {
            return res.status(400).send({ error: 'Reply message is required' });
        }

        const reply = {
            _id: new ObjectId(),
            message: message,
            repliedBy: repliedBy || 'admin@example.com',
            repliedByName: repliedByName || 'Support Team',
            repliedByRole: repliedByRole || 'admin',
            createdAt: new Date()
        };

        const result = await SupportCollection.updateOne(
            { _id: new ObjectId(id) },
            {
                $push: { replies: reply },
                $set: {
                    status: 'answered',
                    updatedAt: new Date(),
                    lastRepliedAt: new Date(),
                    lastRepliedBy: repliedBy
                }
            }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).send({ error: 'Message not found' });
        }

        res.send(reply);
    } catch (error) {
        console.error("Error adding reply:", error);
        res.status(500).send({ error: error.message });
    }
});

app.patch('/support/messages/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const result = await SupportCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status, updatedAt: new Date() } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).send({ error: 'Message not found' });
        }

        res.send({ success: true });
    } catch (error) {
        console.error("Error updating status:", error);
        res.status(500).send({ error: error.message });
    }
});

app.delete('/support/messages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email } = req.query;

        const message = await SupportCollection.findOne({ _id: new ObjectId(id) });

        if (!message) {
            return res.status(404).send({ error: 'Message not found' });
        }

        const user = await UsersCollection.findOne({ email: email });
        if (message.email !== email && user?.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access' });
        }

        const result = await SupportCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).send({ error: 'Message not found' });
        }

        res.send({ success: true });
    } catch (error) {
        console.error("Error deleting message:", error);
        res.status(500).send({ error: error.message });
    }
});

// Health check endpoint
app.get('/', (req, res) => {
    res.send('Hello World! Server is running.');
});

// Export for Vercel, listen locally
if (process.env.VERCEL) {
    module.exports = app;
} else {
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`);
    });
}