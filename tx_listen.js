const { ApiPromise, WsProvider } = require('@polkadot/api');

const ADDRESS_TO_MONITOR = '5HYirYDhaio3stpFYPPDxeiPepm8SVPWDDyjGXW6GrFy5fNj'; // Replace with your address

async function main() {
    // Connect to the Substrate-based node (default: Polkadot testnet)
    const provider = new WsProvider('wss://api.torus.network'); // Replace with your own network if needed
    const api = await ApiPromise.create({ provider });

    console.log(`🔍 Listening for incoming transactions to: ${ADDRESS_TO_MONITOR}`);

    // Subscribe to account balance changes
    api.query.system.account(ADDRESS_TO_MONITOR, async ({ data: { free: currentBalance } }) => {
        console.log(`💰 Balance Updated: ${currentBalance.toHuman()}`);

        // Fetch transaction history from events
        const latestBlock = await api.rpc.chain.getBlock();
        latestBlock.block.extrinsics.forEach(({ method: { method, section }, signer, args }) => {
            // console.log("extrinsic detected");
            // console.log(section," ", method);
            // console.log(args[0].toString());
            if (section === 'balances' && method === 'transferAllowDeath' && args[0].toString() === ADDRESS_TO_MONITOR) {
                const sender = signer.toString();
                const amount = args[1].toHuman();

                console.log(`✅ Incoming Transfer! ${amount} from ${sender}`);
                

                // Call the function when funds are received
                onIncomingTransfer(sender, amount);
            }
        });
    });
}

// Function to execute when a transfer is detected
function onIncomingTransfer(sender, amount) {
    console.log(`🚀 Triggered function: Received ${amount} from ${sender}`);
    // You can add your own logic here, e.g., send an email, trigger a webhook, update a database, etc.
}

// Start listening
main().catch(console.error);
