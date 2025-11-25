import express from "express";
import dotenv from "dotenv";
import deposit from "./api/deposit.js";
import webhook from "./api/ccpayment-webhook.js";

dotenv.config();

const app = express();
app.use(express.json());

// endpoints
app.post("/api/deposit", deposit);
app.post("/api/ccpayment/webhook", webhook);

app.get("/", (req, res) => {
  res.send("MineMechanics backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
