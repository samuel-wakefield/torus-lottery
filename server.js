const { ApiPromise, WsProvider } = require('@polkadot/api');
const express = require('express');
const path = require('path');
const fs = require('fs'); // no longer used for logging, but can be kept for local logs if desired

// require('dotenv').config();

const AWS = require('aws-sdk');
// Configure AWS with your credentials and region (set via environment variables on Render)
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION, // e.g., 'us-west-2'
});

const LOG_BUCKET = process.env.LOG_BUCKET; // your S3 bucket name
const LOG_FILE_KEY = 'fixed-transaction-log.jsonl'; // file name in S3

console.log("LOG_BUCKET:", process.env.LOG_BUCKET);

// Helper function to get the current log from S3
async function getCurrentLog() {
  try {
    const data = await s3.getObject({ Bucket: LOG_BUCKET, Key: LOG_FILE_KEY }).promise();
    return data.Body.toString();
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      // File doesn't exist yet; return empty string
      return '';
    }
    throw err;
  }
}

// Helper function to save updated log to S3
async function saveLogToS3(logContent) {
  const params = {
    Bucket: LOG_BUCKET,
    Key: LOG_FILE_KEY,
    Body: logContent,
    ContentType: 'text/plain'
  };
  return s3.putObject(params).promise();
}

// Function to log a transaction to S3
async function logTransaction(sender, amount) {
  const timestamp = new Date().toISOString();
  const entry = { time: timestamp, sender, amount };
  const newEntry = JSON.stringify(entry) + "\n";
  
  try {
    // Get the current log from S3 (if it exists)
    const currentLog = await getCurrentLog();
    // Append the new entry
    const updatedLog = currentLog + newEntry;
    // Save the updated log back to S3
    await saveLogToS3(updatedLog);
    console.log("Transaction logged to S3:", entry);
  } catch (err) {
    console.error("Error writing transaction log to S3:", err);
  }
}

// Initialize Express app
const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'docs')));
app.use(express.json());

// Global variables for the lottery
let lotteryTickets = {}; // Maps sender address to ticket count
let jackpot = 0;         // Total jackpot (in TORUS tokens)

// Blockchain listener setup
const ADDRESS_TO_MONITOR = '5HYirYDhaio3stpFYPPDxeiPepm8SVPWDDyjGXW6GrFy5fNj'; // Replace with your address

async function startBlockchainListener() {
  const provider = new WsProvider('wss://api.torus.network'); // Replace with your own network if needed
  const api = await ApiPromise.create({ provider });

  console.log(`🔍 Listening for incoming transactions to: ${ADDRESS_TO_MONITOR}`);

  // Subscribe to account balance changes
  api.query.system.account(ADDRESS_TO_MONITOR, async ({ data: { free: currentBalance } }) => {
    console.log(`💰 Balance Updated: ${currentBalance.toHuman()}`);

    // Fetch transaction history from events in the latest block
    const latestBlock = await api.rpc.chain.getBlock();
    latestBlock.block.extrinsics.forEach(({ method: { method, section }, signer, args }) => {
      if (section === 'balances' && (method === 'transferAllowDeath' || method === 'transfer'|| method === 'transferKeepAlive') && args[0].toString() === ADDRESS_TO_MONITOR) {
        const sender = signer.toString();
        const amount = args[1].toHuman();
        console.log(`✅ Incoming Transfer! ${amount} from ${sender}`);
        onIncomingTransfer(sender, amount);
      }
    });
  });
}

// Process an incoming transfer: remove commas, convert from minimal units to human-readable tokens,
// calculate tickets (1 ticket per 0.1 TORUS), update global state, and log the transaction.
function onIncomingTransfer(sender, amount) {
  console.log(`🚀 Triggered function: Received ${amount} from ${sender}`);
  const rawAmount = parseFloat(amount.replace(/,/g, ''));
  const numericAmount = rawAmount / 1e18; // Assumes 1 TORUS = 1e18 minimal units.
  const ticketsAwarded = Math.floor(numericAmount / 0.1);

  if (ticketsAwarded <= 0) {
    console.log(`❌ Transfer amount ${numericAmount} TORUS is too low to award any lottery tickets.`);
    return;
  }

  jackpot += numericAmount;

  if (lotteryTickets[sender]) {
    lotteryTickets[sender] += ticketsAwarded;
  } else {
    lotteryTickets[sender] = ticketsAwarded;
  }
  console.log(`🎟 Added ${ticketsAwarded} lottery tickets for ${sender}. Total tickets for sender: ${lotteryTickets[sender]}`);

  // Log the transaction to S3 for backup
  logTransaction(sender, numericAmount);
}

// Lottery functions for use by the API:

// Get a summary of all entrants.
function getEntrantsData() {
  const totalTickets = Object.values(lotteryTickets).reduce((sum, tickets) => sum + tickets, 0);
  return { entrants: lotteryTickets, jackpot, totalTickets };
}

// Draw a winner based on weighted lottery.
function drawWinner() {
  const totalTickets = Object.values(lotteryTickets).reduce((sum, tickets) => sum + tickets, 0);
  if (totalTickets === 0) {
    return { message: "No lottery entries available to draw a winner." };
  }
  const randomTicket = Math.floor(Math.random() * totalTickets);
  let cumulative = 0;
  let winner = null;
  for (const [address, tickets] of Object.entries(lotteryTickets)) {
    cumulative += tickets;
    if (randomTicket < cumulative) {
      winner = address;
      break;
    }
  }
  const result = { winner, jackpot, totalTickets };
  // Reset lottery for next round.
  lotteryTickets = {};
  jackpot = 0;
  return result;
}

// Get the ticket count for a given wallet.
function getTicketCount(address) {
  const tickets = lotteryTickets[address] || 0;
  return { address, tickets };
}

// Express API endpoints:

// Returns a JSON summary of all entrants.
app.get('/api/entrants', (req, res) => {
  res.json(getEntrantsData());
});

// Returns the ticket count for a specific wallet address.
app.get('/api/tickets/:address', (req, res) => {
  res.json(getTicketCount(req.params.address));
});

// Triggers a lottery draw.
app.post('/api/draw', (req, res) => {
  res.json(drawWinner());
});

// Start the Express server.
app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});

// Start the blockchain listener.
startBlockchainListener().catch(console.error);