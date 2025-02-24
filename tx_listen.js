const { ApiPromise, WsProvider } = require('@polkadot/api');
const readline = require('readline');

const ADDRESS_TO_MONITOR = '5HYirYDhaio3stpFYPPDxeiPepm8SVPWDDyjGXW6GrFy5fNj'; // Replace with your address

// Global variables for the lottery
let lotteryTickets = {}; // Maps sender address to ticket count
let jackpot = 0;         // Total jackpot (in TORUS tokens)

async function main() {
    // Connect to the Substrate-based node (default: Polkadot testnet)
    const provider = new WsProvider('wss://api.torus.network'); // Replace with your own network if needed
    const api = await ApiPromise.create({ provider });

    console.log(`🔍 Listening for incoming transactions to: ${ADDRESS_TO_MONITOR}`);

    // Subscribe to account balance changes
    api.query.system.account(ADDRESS_TO_MONITOR, async ({ data: { free: currentBalance } }) => {
        console.log(`💰 Balance Updated: ${currentBalance.toHuman()}`);

        // Fetch transaction history from events in the latest block
        const latestBlock = await api.rpc.chain.getBlock();
        latestBlock.block.extrinsics.forEach(({ method: { method, section }, signer, args }) => {
            if (section === 'balances' && method === 'transferAllowDeath' && args[0].toString() === ADDRESS_TO_MONITOR) {
                const sender = signer.toString();
                const amount = args[1].toHuman();

                console.log(`✅ Incoming Transfer! ${amount} from ${sender}`);

                // Process the incoming transfer
                onIncomingTransfer(sender, amount);
            }
        });
    });
}

// Function to execute when a transfer is detected
function onIncomingTransfer(sender, amount) {
    console.log(`🚀 Triggered function: Received ${amount} from ${sender}`);

    // Remove commas and parse the amount, then convert from smallest unit to human tokens.
    // Assumes 1 TORUS = 1e18 minimal units.
    const rawAmount = parseFloat(amount.replace(/,/g, ''));
    const numericAmount = rawAmount / 1e18;

    // Calculate tickets: Each 0.1 TORUS gives 1 ticket (rounding down).
    const ticketsAwarded = Math.floor(numericAmount / 0.1);

    if (ticketsAwarded <= 0) {
        console.log(`❌ Transfer amount ${numericAmount} TORUS is too low to award any lottery tickets.`);
        return;
    }

    // Increase jackpot by the full deposited amount (in human-readable TORUS).
    jackpot += numericAmount;

    // Accumulate tickets for the sender.
    if (lotteryTickets[sender]) {
        lotteryTickets[sender] += ticketsAwarded;
    } else {
        lotteryTickets[sender] = ticketsAwarded;
    }
    console.log(`🎟 Added ${ticketsAwarded} lottery tickets for ${sender}. Total tickets for sender: ${lotteryTickets[sender]}`);
}

// Function to display all lottery entrants and their ticket numbers, plus totals.
function displayEntrants() {
    console.log("\n📋 Current Lottery Entrants:");
    if (Object.keys(lotteryTickets).length === 0) {
        console.log("No lottery entries yet.");
        return;
    }

    let totalTickets = 0;
    for (const [address, tickets] of Object.entries(lotteryTickets)) {
        console.log(`- ${address}: ${tickets} ticket(s)`);
        totalTickets += tickets;
    }
    console.log(`\nTotal tickets: ${totalTickets}`);
    console.log(`Current jackpot: ${jackpot} TORUS\n`);
}

// Function to draw a winner from the current lottery entries.
function drawWinner() {
    let totalTickets = Object.values(lotteryTickets).reduce((sum, tickets) => sum + tickets, 0);

    if (totalTickets === 0) {
        console.log("No lottery entries available to draw a winner.");
        return;
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

    console.log(`🎉 The winner is: ${winner}`);
    console.log(`💰 Jackpot total: ${jackpot} TORUS`);
    console.log(`Total tickets in lottery: ${totalTickets}`);

    // Reset the lottery for the next round.
    lotteryTickets = {};
    jackpot = 0;
}

// Function to get the ticket count for a specific wallet address.
function getTicketCount(address) {
    const tickets = lotteryTickets[address] || 0;
    console.log(`🧾 Wallet ${address} has ${tickets} ticket(s).`);
    return tickets;
}

// Set up the readline interface for manual command input.
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
console.log("Commands:\n- 'draw' to trigger the lottery draw\n- 'list' to display current entrants\n- 'tickets <walletAddress>' to get ticket count for a wallet");

rl.on('line', (input) => {
    const trimmedInput = input.trim();

    if (trimmedInput.toLowerCase() === 'draw') {
        drawWinner();
    } else if (trimmedInput.toLowerCase() === 'list') {
        displayEntrants();
    } else {
        // Use a regex to allow "tickets <walletAddress>" with a space
        const ticketRegex = /^tickets\s+(\S+)$/i;
        const match = trimmedInput.match(ticketRegex);
        if (match) {
            const walletAddress = match[1];
            getTicketCount(walletAddress);
        } else {
            console.log("Unrecognized command. Use 'draw', 'list', or 'tickets <walletAddress>'.");
        }
    }
});

// Start listening
main().catch(console.error);