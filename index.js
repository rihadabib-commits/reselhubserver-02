

// ⚠️ সবার আগে dotenv কনফিগার করতে হবে মামা, না হলে স্ট্রাইপ ক্র্যাশ করবে!
const dotenv = require("dotenv");
dotenv.config();

// 🔑 এবার স্ট্রাইপ ডিক্লেয়ার করলে সে সুন্দরভাবে তোমার sk_test কী খুঁজে পাবে
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 5000;

// 🛠️ CORS কনফিগারেশন
app.use(cors({
  origin: ['http://localhost:3000', 'https://resellhub-01.vercel.app', `https://resellhub-01.vercel.app`,],
  credentials: true
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});




const checkNotBlocked = (usersCol) => async (req, res, next) => {
  const user = await usersCol.findOne({ email: req.user?.email });
  if (user?.status === 'blocked') {
    return res.status(403).json({ message: 'Your account has been blocked. Contact admin.' });
  }
  next();
};

// async function run() {
//   try {
//     await client.connect();

    const db = client.db('reselhundb');
    
    const usersCol = db.collection('users');
    const productsCol = db.collection('products');
    const ordersCol = db.collection('orders');
    const reviewsCol = db.collection('reviews');
    const wishlistCol = db.collection('wishlist'); // ❤️ উইশলিস্ট কালেকশন
    const paymentsHistoryCol = db.collection('payments_history'); 
    const blockCheck = checkNotBlocked(usersCol);
    // 💳 পেমেন্ট কালেকশন

    // ─── JWT ───────────────────────────────────────────
    app.post('/jwt', (req, res) => {
      const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.json({ token });
    });

    // ─── 💳 STRIPE INTEGRATION ROUTES ───────────────────
    
    // ১. পেমেন্টের জন্য ক্লায়েন্ট সিক্রেট তৈরি করা (Stripe requirement)
    app.post('/create-payment-intent', async (req, res) => {
      const { price } = req.body;
      if (!price || isNaN(price)) {
        return res.status(400).json({ error: "Invalid price provided" });
      }
      const amount = parseInt(parseFloat(price) * 100); // সেন্ট কনভার্সন

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amount,
          currency: 'usd',
          payment_method_types: ['card']
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ২. পেমেন্ট ও অর্ডার কমপ্লিট করার মেইন সিকিউর রুট
    app.post('/api/orders', blockCheck,  async (req, res) => {
      try {
        const orderData = req.body;
        
        const finalPaymentRecord = {
          productId: orderData.productId,
          title: orderData.title,
          price: Number(orderData.price),
          tax: Number(orderData.tax || 0),
          totalPayable: Number(orderData.totalPayable),
          transactionId: orderData.transactionId, // স্ট্রাইপ থেকে আসা ইউনিক ট্রানজেকশন আইডি
          sellerId: orderData.sellerId,
          sellerName: orderData.sellerName,
          sellerEmail: orderData.sellerEmail,
          buyerPhone: orderData.buyerPhone,
          buyerAddress: orderData.buyerAddress,
          buyerEmail: orderData.buyerEmail, 
          paymentStatus: 'Paid',            
          orderStatus: 'Pending',           
          createdAt: new Date()
        };

        // ক) payments_history কালেকশনে ডাটা পুশ
        const paymentResult = await paymentsHistoryCol.insertOne(finalPaymentRecord);

        // খ) orders কালেকশনেও ডাটা পুশ (অ্যাসাইনমেন্ট ট্র্যাকিং রিকোয়ারমেন্টের জন্য)
        await ordersCol.insertOne({
          buyerInfo: { name: orderData.buyerName, email: orderData.buyerEmail },
          sellerInfo: { name: orderData.sellerName, email: orderData.sellerEmail },
          productId: orderData.productId,
          productTitle: orderData.title,
          price: Number(orderData.totalPayable),
          paymentStatus: 'paid',
          orderStatus: 'pending',
          transactionId: orderData.transactionId,
          createdAt: new Date()
        });

        // গ) প্রোডাক্টটি যদি উইশলিস্ট থেকে এসে থাকে তবে উইশলিস্ট থেকে ডিলিট করা
        if (orderData.wishlistId) {
          await wishlistCol.deleteOne({ _id: new ObjectId(orderData.wishlistId) });
        }

        res.status(201).json({
          success: true,
          message: '🎉 পেমেন্ট এবং অর্ডার ডেটা সফলভাবে সেভ হয়েছে মামা!',
          insertedId: paymentResult.insertedId
        });
      } catch (error) {
        console.error("Payment Save Error:", error);
        res.status(500).json({ success: false, message: "Server Error", error: error.message });
      }
    });

    // ─── ❤️ WISHLIST ROUTES ─────────────────────────────
    app.post('/wishlist', blockCheck,  async (req, res) => {
      const item = req.body;
      const result = await wishlistCol.insertOne(item);
      res.json(result);
    });

    app.get('/wishlist/:email', async (req, res) => {
      const result = await wishlistCol.find({ buyerEmail: req.params.email }).toArray();
      res.json(result);
    });

    app.delete('/wishlist/:id', async (req, res) => {
      const result = await wishlistCol.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    // ─── USERS ─────────────────────────────────────────
    app.post('/users', async (req, res) => {
      const user = req.body;
      const exists = await usersCol.findOne({ email: user.email });
      if (exists) return res.json({ message: 'User already exists' });
      const result = await usersCol.insertOne({ ...user, role: user.role || 'buyer', status: 'active', createdAt: new Date() });
      res.json(result);
    });

    
    app.get('/users', async (req, res) => {
      const result = await usersCol.find().toArray();
      res.json(result);
    });

    app.get('/users/:email', async (req, res) => {
      const result = await usersCol.findOne({ email: req.params.email });
      res.json(result);
    });

    app.patch('/users/:id', async (req, res) => {
      const result = await usersCol.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: req.body }
      );
      res.json(result);
    });

    app.delete('/users/:id', async (req, res) => {
      const result = await usersCol.deleteOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    // ─── PRODUCTS ──────────────────────────────────────
    app.get('/products', async (req, res) => {
      const { search, category, sort } = req.query;
      let query = { status: 'available' };
      if (search) query.title = { $regex: search, $options: 'i' };
      if (category) query.category = category;
      let sortOption = {};
      if (sort === 'low') sortOption.price = 1;
      if (sort === 'high') sortOption.price = -1;
      const result = await productsCol.find(query).sort(sortOption).toArray();
      res.json(result);
    });

    app.get('/products/:id', async (req, res) => {
      const result = await productsCol.findOne({ _id: new ObjectId(req.params.id) });
      res.json(result);
    });

    app.post('/products', blockCheck,   async (req, res) => {
      const product = { ...req.body, status: 'available', createdAt: new Date() };
      const result = await productsCol.insertOne(product);
      res.json(result);
    });

    // ─── ORDERS ────────────────────────────────────────
    app.post('/orders', async (req, res) => {
      const order = { ...req.body, orderStatus: 'pending', createdAt: new Date() };
      const result = await ordersCol.insertOne(order);
      res.json(result);
    });

    app.get('/orders', async (req, res) => {
      const result = await ordersCol.find().toArray();
      res.json(result);
    });

    app.get('/my-orders/:email', async (req, res) => {
      const result = await ordersCol.find({ 'buyerInfo.email': req.params.email }).toArray();
      res.json(result);
    });

    app.get('/payments/:email', async (req, res) => {
      const result = await paymentsHistoryCol.find({ buyerEmail: req.params.email }).toArray();
      res.json(result);
    });

    app.get('/api/products', async (req, res) => {
    const products = await productsCol.find({}).toArray();
    res.json(products);
});

app.delete('/api/products/:id', async (req, res) => {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await productsCol.deleteOne(query);
    res.json(result);
});

// তোমার index.js ফাইলে এই কোডটি বসাও (run ফাংশনের ভেতরে)
app.get('/api/seller/sales-trend', async (req, res) => {
    try {
        const allOrders = await ordersCol.find({}).toArray();
        
        // এখানে আমরা createdAt থেকে তারিখ বের করে সপ্তাহে ভাগ করছি
        const trend = [
            { week: "W1", amount: 0 },
            { week: "W2", amount: 0 },
            { week: "W3", amount: 0 },
            { week: "W4", amount: 0 }
        ];

        allOrders.forEach(order => {
            const date = new Date(order.createdAt);
            const day = date.getDate();
            // সহজ লজিক: মাসের দিনের ওপর ভিত্তি করে সপ্তাহে ভাগ করা
            if (day <= 7) trend[0].amount += order.price;
            else if (day <= 14) trend[1].amount += order.price;
            else if (day <= 21) trend[2].amount += order.price;
            else trend[3].amount += order.price;
        });

        res.json(trend);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch sales data" });
    }
});




// index.js বা server.js ফাইলে
app.get('/api/seller/total-sales', async (req, res) => {
    try {
        const allOrders = await ordersCol.find({}).toArray();
        // সব অর্ডারের প্রাইস যোগ করা
        const total = allOrders.reduce((sum, order) => sum + (parseFloat(order.price) || 0), 0);
        res.json({ totalSales: total });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch" });
    }
});


// সব অর্ডার পাওয়ার জন্য
app.get('/api/orders', async (req, res) => {
    const orders = await ordersCol.find({}).toArray();
    res.json(orders);
});

// স্ট্যাটাস আপডেট করার জন্য
app.patch('/api/orders/:id', async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const filter = { _id: new ObjectId(id) };
    const updateDoc = { $set: { status: status } };
    const result = await ordersCol.updateOne(filter, updateDoc);
    res.json(result);
});


// index.js ফাইলের ভেতরে run() ফাংশনের ভেতরে এটি যোগ করো
// index.js এ এই অংশটি নিশ্চিত করো
// app.patch('/api/orders/:id', async (req, res) => {
//     const id = req.params.id;
//     const { status } = req.body; 
//     try {
//         const query = { _id: new ObjectId(id) };
//         // ডাটাবেজের ফিল্ড নাম যদি 'orderStatus' হয়, তবে এখানে 'orderStatus' লেখো
//         const updateDoc = { $set: { status: status } }; 
        
//         const result = await ordersCol.updateOne(query, updateDoc);
        
//         if (result.modifiedCount > 0) {
//             res.json({ success: true, message: "Status updated" });
//         } else {
//             res.status(400).json({ message: "No changes made" });
//         }
//     } catch (error) {
//         res.status(500).json({ error: "Server side error" });
//     }
// });


app.patch('/api/orders/:id', async (req, res) => {
    const id = req.params.id;
    const { status } = req.body; // ফ্রন্টএন্ড থেকে 'Accepted' বা অন্য কিছু আসছে

    try {
        const query = { _id: new ObjectId(id) };
        
        // লজিক: সেলার যখন 'Accepted' করবে, পেমেন্ট পেইড হবে। 
        // অন্য কোনো স্ট্যাটাস (যেমন Shipped/Delivered) দিলে পেমেন্ট স্ট্যাটাস আগের মতোই থাকবে।
        const updateDoc = { 
            $set: { 
                status: status,
                paymentStatus: status === 'Accepted' ? 'paid' : 'pending' 
            } 
        }; 
        
        const result = await ordersCol.updateOne(query, updateDoc);
        
        if (result.modifiedCount > 0) {
            res.json({ success: true, message: "Status and Payment updated successfully" });
        } else {
            res.status(400).json({ message: "No changes made to the record" });
        }
    } catch (error) {
        console.error("Update error:", error);
        res.status(500).json({ error: "Server side error" });
    }
});



app.patch('/api/test-update/:id', async (req, res) => {
    const id = req.params.id;
    console.log("Updating order ID:", id); // কনসোলে আইডি আসছে কি না দেখো
    try {
        const result = await ordersCol.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: 'Accepted' } } // সরাসরি হার্ডকোড করে দেখো ডাটাবেজ আপডেট হয় কি না
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// তোমার run() ফাংশনের ভেতরে যেকোনো জায়গায় এটি বসিয়ে দাও
app.get('/api/seller/stats', async (req, res) => {
    try {
        // তোমার কালেকশন ভেরিয়েবল অনুযায়ী কোড:
        const totalProducts = await productsCol.countDocuments();
        const allOrders = await ordersCol.find({}).toArray();
        
        const totalRevenue = allOrders.reduce((sum, order) => sum + (parseFloat(order.price) || 0), 0);
        
        res.json({
            totalProducts: totalProducts,
            totalSales: allOrders.length,
            totalRevenue: totalRevenue,
            pendingOrders: 2 // আপাতত ডামি, পরে এটি ডাটাবেজ থেকে ফিল্টার করে নিও
        });
    } catch (error) {
        console.error("Stats Error:", error);
        res.status(500).json({ error: "Server side error" });
    }
});







app.patch("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const result = await ordersCol.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          orderStatus: status,
        },
      }
    );

    res.send(result);
  } catch (err) {
    res.status(500).send(err);
  }
});


app.patch('/api/products/:id', async (req, res) => {
    const id = req.params.id;
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
        $set: {
            title: req.body.title,
            category: req.body.category,
            condition: req.body.condition,
            price: req.body.price,
            stock: req.body.stock,
            description: req.body.description
        },
    };
    const result = await productsCol.updateOne(filter, updateDoc);
    res.json(result);
});

      

app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalUsers = await usersCol.countDocuments();
        const totalProducts = await productsCol.countDocuments();
        const totalOrders = await ordersCol.countDocuments();
        
        res.json({ totalUsers, totalProducts, totalOrders });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});



// শুধু এই অংশটি রাখো, বাকি ডুপ্লিকেটগুলো ডিলিট করে দাও
app.get('/api/users', async (req, res) => {
    try {
        const users = await usersCol.find({}).toArray();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
});

app.patch('/api/users/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await usersCol.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Update failed" });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        const result = await usersCol.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Delete failed" });
    }
});// এখন:




// ১. প্রোডাক্ট অ্যাড করার সময় 'pending' থাকবে
app.post('/products', async (req, res) => {
  const product = { ...req.body, status: 'pending', createdAt: new Date() };
  const result = await productsCol.insertOne(product);
  res.json(result);
});

// ২. অ্যাডমিনের জন্য স্ট্যাটাস আপডেট করার রুট (Approve/Reject)
app.patch('/api/products/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'available' অথবা 'rejected'
  const result = await productsCol.updateOne(
    { _id: new ObjectId(id) }, 
    { $set: { status: status } }
  );
  res.json(result);
});

// বায়ারের জন্য প্রোডাক্ট রুট (শুধু 'available' গুলাই দেখাবে)
app.get('/products', async (req, res) => {
  const { search, category, sort } = req.query;
  // এখানে ফিল্টার দিয়ে দাও যাতে শুধু 'available' গুলো আসে
  let query = { status: 'available' }; 
  
  if (search) query.title = { $regex: search, $options: 'i' };
  if (category) query.category = category;
  
  const result = await productsCol.find(query).toArray();
  res.json(result);
});

app.patch('/api/products/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const result = await productsCol.updateOne(
    { _id: new ObjectId(id) }, 
    { $set: { status: status } }
  );
  res.json(result);
});

// সব প্রোডাক্ট দেখার জন্য (অ্যাডমিন প্যানেলের জন্য)
app.get('/api/admin/products', async (req, res) => {
    const products = await productsCol.find({}).toArray();
    res.json(products);
});

// প্রোডাক্ট স্ট্যাটাস আপডেট (Approve/Reject)
app.patch('/api/products/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'available', 'rejected', 'pending'
    const result = await productsCol.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: status } }
    );
    res.json(result);
});

// ডিলিট করার জন্য
app.delete('/api/products/:id', async (req, res) => {
    const result = await productsCol.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json(result);
});


app.get('/products', async (req, res) => {
    // শুধুমাত্র সেই প্রোডাক্ট দেখাবে যার স্ট্যাটাস 'available'
    const query = { status: 'available' };
    const result = await productsCol.find(query).toArray();
    res.json(result);
});



 

app.get('/api/users', async (req, res) => {
    try {
        const users = await usersCol.find({ role: { $in: ['buyer', 'seller'] } }).toArray();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
});


    // ─── STATS ─────────────────────────────────────────
    app.get('/stats', async (req, res) => {
      const totalUsers = await usersCol.countDocuments();
      const totalProducts = await productsCol.countDocuments();
      const totalOrders = await ordersCol.countDocuments();
      const buyers = await usersCol.countDocuments({ role: 'buyer' });
      const sellers = await usersCol.countDocuments({ role: 'seller' });
      res.json({ totalUsers, totalProducts, totalOrders, buyers, sellers });
    });

    // ─── নতুন করে যোগ করার জন্য সেলারের রুটসমূহ (বায়ারের কোডে হাত না দিয়ে) ───

// ১. সেলারের প্রোডাক্ট লিস্ট দেখার জন্য
app.get('/my-products/:email', async (req, res) => {
  const result = await productsCol.find({ sellerEmail: req.params.email }).toArray();
  res.json(result);
});

// ২. সেলারের প্রোডাক্ট অ্যাড করার জন্য
app.post('/products', async (req, res) => {
  const product = { ...req.body, status: 'available', createdAt: new Date() };
  const result = await productsCol.insertOne(product);
  res.json(result);
});

// ৩. সেলারের প্রোডাক্ট ডিলিট করার জন্য
app.delete('/products/:id', async (req, res) => {
  const result = await productsCol.deleteOne({ _id: new ObjectId(req.params.id) });
  res.json(result);
});

//     console.log("Connected to MongoDB -> reselhundb Database!");
//   } finally {}
// }
// run().catch(console.dir);

app.get('/', (req, res) => res.send('ReSell Hub Server Running'));
app.listen(port, () => console.log(`Server running on port ${port}`));

