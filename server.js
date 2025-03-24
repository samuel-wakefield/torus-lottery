// server.js

const { ApiPromise, WsProvider } = require('@polkadot/api');
const express = require('express');
const path = require('path');
const fs = require('fs'); // Optional, for local logging

// Uncomment the next line for local development to load your .env file.
// require('dotenv').config();

const AWS = require('aws-sdk');
// Configure AWS with your credentials and region (set via environment variables on Render)
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION, // e.g., 'eu-north-1'
});

const LOG_BUCKET = process.env.LOG_BUCKET; // your S3 bucket name
console.log("LOGBUCKET: ", LOG_BUCKET)
const LOG_FILE_KEY = 'fixed-transaction-log.jsonl'; // file name in S3

console.log("LOG_BUCKET:", LOG_BUCKET);

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

// ***** NEW FUNCTION: Rebuild the lottery state from the persistent S3 log ***** 
async function loadLotteryStateFromLog() {
  try {
    const logContent = await getCurrentLog();
    if (!logContent) {
      console.log("No existing log found. Starting with empty state.");
      return;
    } else {
      console.log("S3 log found: \n", logContent)
    }
    const lines = logContent.trim().split("\n");
    // Reset current state so we don't double count
    lotteryTickets = {};
    jackpot = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Calculate tickets for this entry (1 ticket per 0.1 TORUS)
        const ticketsAwarded = Math.floor(entry.amount / 0.1);
        jackpot += entry.amount;
        if (lotteryTickets[entry.sender]) {
          lotteryTickets[entry.sender] += ticketsAwarded;
        } else {
          lotteryTickets[entry.sender] = ticketsAwarded;
        }
      } catch (err) {
        console.error("Error parsing log line:", line, err);
      }
    }
    console.log("Reconstructed lottery state from S3 log:", { lotteryTickets, jackpot });
  } catch (err) {
    console.error("Error loading lottery state from S3 log:", err);
  }
}
// ***** END NEW FUNCTION *****

// Global variables for the lottery (initially empty; rebuilt on startup)
let lotteryTickets = {}; // Maps sender address to ticket count
let jackpot = 0;         // Total jackpot (in TORUS tokens)

// Initialize Express app
const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'docs')));
app.use(express.json());

// Blockchain listener setup
const ADDRESS_TO_MONITOR = '5HYirYDhaio3stpFYPPDxeiPepm8SVPWDDyjGXW6GrFy5fNj'; // Lottery wallet address

async function startBlockchainListener() {
  const provider = new WsProvider('wss://api.torus.network');
  const api = await ApiPromise.create({ provider });

  console.log(`🔍 Listening for incoming transactions to: ${ADDRESS_TO_MONITOR}`);

  // Subscribe to account balance changes
  api.query.system.account(ADDRESS_TO_MONITOR, async ({ data: { free: currentBalance } }) => {
    console.log(`💰 Balance Updated: ${currentBalance.toHuman()}`);

    // Fetch transaction history from events in the latest block
    const latestBlock = await api.rpc.chain.getBlock();
    latestBlock.block.extrinsics.forEach(({ method: { method, section }, signer, args }) => {
      if (
        section === 'balances' &&
        (method === 'transferAllowDeath' || method === 'transfer' || method === 'transferKeepAlive') &&
        args[0].toString() === ADDRESS_TO_MONITOR
      ) {
        const sender = signer.toString();
        const amount = args[1].toHuman();
        console.log(`✅ Incoming Transfer! ${amount} from ${sender}`);
        onIncomingTransfer(sender, amount);
      }
    });
  });
}

// Process an incoming transfer: convert amount, calculate tickets, update state, and log transaction.
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

// Lottery API helper functions

function getEntrantsData() {
  const totalTickets = Object.values(lotteryTickets).reduce((sum, tickets) => sum + tickets, 0);
  return { entrants: lotteryTickets, jackpot, totalTickets };
}

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

function getTicketCount(address) {
  const tickets = lotteryTickets[address] || 0;
  return { address, tickets };
}

// Express API endpoints

app.get('/api/entrants', (req, res) => {
  res.json(getEntrantsData());
});

app.get('/api/tickets/:address', (req, res) => {
  res.json(getTicketCount(req.params.address));
});

app.post('/api/draw', (req, res) => {
  res.json(drawWinner());
});

// ***** Startup Sequence *****
// First, load the lottery state from S3 log.
// This ensures that if the Render instance has restarted, you rebuild the state
// from the persistent S3 backup.
loadLotteryStateFromLog().then(() => {
  // Then, start the Express server and blockchain listener.
  app.listen(port, () => {
    console.log(`Express server listening at http://localhost:${port}`);
  });
  startBlockchainListener().catch(console.error);
}).catch(err => {
  console.error("Error loading lottery state:", err);
  // Even if there's an error, start the server and listener.
  app.listen(port, () => {
    console.log(`Express server listening at http://localhost:${port}`);
  });
  startBlockchainListener().catch(console.error);
});