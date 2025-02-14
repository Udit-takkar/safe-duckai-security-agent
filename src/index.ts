import { config as dotenv } from "dotenv";
import express, { Request, Response } from "express";
import { P2PClient } from "../sdk/src/p2p";
import { Message } from "../sdk/src/p2p/types";
import { processMessage } from "./agent";
import { Logger } from "./utils/logger";
import SafeApiKit, { SafeInfoResponse } from "@safe-global/api-kit";
import { SafeMultisigTransactionResponse } from "@safe-global/types-kit";
import securityService from "./securityService";
import Safe, {
  PredictedSafeProps,
  SafeAccountConfig,
} from "@safe-global/protocol-kit";

// Load environment variables
dotenv();

// Initialize client variable in broader scope
let client: P2PClient;

// Initialize Express app
const app = express();
app.use(express.json());

const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS;
const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const HUMAN_SIGNER_1_ADDRESS = process.env.HUMAN_SIGNER_1_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;

async function initializeSafeAccount() {
  if (
    !SIGNER_PRIVATE_KEY ||
    !RPC_URL ||
    !SAFE_ADDRESS ||
    !SIGNER_ADDRESS ||
    !HUMAN_SIGNER_1_ADDRESS
  ) {
    throw new Error("Missing environment variables in .env file");
  }

  const safeAccountConfig: SafeAccountConfig = {
    owners: [SIGNER_ADDRESS, HUMAN_SIGNER_1_ADDRESS],
    threshold: 2,
  };

  const predictedSafe: PredictedSafeProps = {
    safeAccountConfig,
  };

  const safe = await Safe.default.init({
    provider: RPC_URL,
    signer: SIGNER_PRIVATE_KEY,
    predictedSafe,
  });

  return safe;
}

const runSecurityChecks = async (
  tx: SafeMultisigTransactionResponse,
  safeInfo: SafeInfoResponse
) => {
  const { safe, securityChecks, summary, aiAnalysis } =
    await securityService.analyzeTransaction(tx);

  if (!safe) {
    Logger.info("security", "Transaction is not safe", {
      txHash: tx.transactionHash,
    });
  }

  return {
    safe,
    securityChecks,
    summary,
    aiAnalysis,
  };
};

const analyzePendingTransactions = async ({
  chainId,
  safeAddress,
}: {
  chainId: bigint;
  safeAddress: string;
}) => {
  const apiKit = new SafeApiKit.default({
    chainId,
  });

  const safeAcc = await initializeSafeAccount();

  const transactions = await apiKit.getPendingTransactions(safeAddress);

  console.log("transactions", transactions);

  const notExecutedTransactions = transactions.results.filter(
    (tx: SafeMultisigTransactionResponse) => tx.executionDate === null
  );

  console.log("notExecutedTransactions", notExecutedTransactions);

  const transactionsResults = [];

  if (notExecutedTransactions.length) {
    const safeInfo = await apiKit.getSafeInfo(notExecutedTransactions[0].safe);

    for (const tx of notExecutedTransactions) {
      const { safe, securityChecks, summary, aiAnalysis } =
        await runSecurityChecks(tx, safeInfo);

      transactionsResults.push({
        safe,
        securityChecks,
        summary,
        aiAnalysis,
      });

      if (!safe) {
        Logger.info("security", "Transaction is not safe", {
          txHash: tx.transactionHash,
        });

        return {
          safe: false,
          securityChecks,
          summary,
          aiAnalysis,
        };
      }

      try {
        const signature = await safeAcc.signHash(tx.safeTxHash);

        await apiKit.confirmTransaction(tx.safeTxHash, signature.data);
      } catch (error) {
        Logger.error("security", "Failed to sign transaction", {
          txHash: tx.transactionHash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    safe: true,
    transactionsResults,
    lastTransaction:
      notExecutedTransactions[notExecutedTransactions.length - 1],
  };
};

async function handleMessage(message: Message) {
  try {
    Logger.info("agent", "Got message", {
      from: message.fromAgentId,
      content: message.content,
    });

    // Process message with LLM
    const response = await processMessage(message.content);

    // Send response back to sender
    await client.sendMessage(message.fromAgentId, response);
  } catch (error) {
    Logger.error("agent", "Failed to handle message", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

app.post("/api/market-sentiment", (req: Request, res: Response) => {
  (async () => {
    try {
      const MARKET_SENTIMENT_AGENT_ID =
        "0x2e2390c874a089bEbFdF47BCaA39067Ef5dFF967";

      const { message } = req.body;

      Logger.info("http", "Sending message to market sentiment agent", {
        agentId: MARKET_SENTIMENT_AGENT_ID,
      });

      // Set up response headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Create a Promise that will resolve when we receive a response
      const responsePromise = new Promise<string>((resolve) => {
        // Set up a one-time message handler for this request
        const messageHandler = (message: Message) => {
          if (message.fromAgentId === MARKET_SENTIMENT_AGENT_ID) {
            resolve(message.content);
            // Remove this handler after receiving the response
            client.onMessage((msg) => {}); // Reset to empty handler
          }
        };

        client.onMessage(messageHandler);
      });

      // Send the message
      await client.sendMessage(MARKET_SENTIMENT_AGENT_ID, message);

      // Wait for the response
      const response = await responsePromise;

      Logger.info("http", "Received response from market sentiment agent", {
        response,
      });

      // Send the response as a single message
      const data = {
        model: process.env.AGENT_NAME || "default-agent",
        created_at: new Date().toISOString(),
        response: response,
        done: false,
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      // Send final chunk to indicate completion
      const finalData = {
        model: process.env.AGENT_NAME || "default-agent",
        created_at: new Date().toISOString(),
        response: "",
        done: true,
      };
      res.write(`data: ${JSON.stringify(finalData)}\n\n`);
      res.end();
    } catch (error) {
      Logger.error("http", "Failed to handle chat message", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        error: { message: "Failed to process message" },
      });
    }
  })();
});

app.post("/api/transaction-analysis", (req: Request, res: Response) => {
  (async () => {
    try {
      const { safeAddress, chainId = 11155111n } = req.body;

      Logger.info("http", "Analyzing pending transactions", {
        safeAddress,
      });

      // Set up response headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const response = await analyzePendingTransactions({
        safeAddress,
        chainId,
      });

      const MARKET_SENTIMENT_AGENT_ID =
        "0x2e2390c874a089bEbFdF47BCaA39067Ef5dFF967";

      // Create a Promise that will resolve when we receive a response
      const responsePromise = new Promise<string>((resolve) => {
        // Set up a one-time message handler for this request
        const messageHandler = (message: Message) => {
          if (message.fromAgentId === MARKET_SENTIMENT_AGENT_ID) {
            resolve(message.content);
            // Remove this handler after receiving the response
            client.onMessage((msg) => {}); // Reset to empty handler
          }
        };

        client.onMessage(messageHandler);
      });

      const message = `Analyze market conditions for a Safe transaction:
      Value: ${response.lastTransaction.value} Wei
      To: ${response.lastTransaction.to}
      Data: ${response.lastTransaction.data}

      Here is the complete transaction:
      ${JSON.stringify(response.lastTransaction)}
      
      Please provide:
      1. Market sentiment (bullish/bearish/neutral)
      2. Brief market analysis
      3. Risk assessment for transaction timing`;

      // Send the message
      await client.sendMessage(MARKET_SENTIMENT_AGENT_ID, message);

      // Wait for the response
      const marketSentimentResponse = await responsePromise;

      Logger.info("http", "Received response from market sentiment agent", {
        response,
      });

      // Send the response as a single message
      const data = {
        model: process.env.AGENT_NAME || "default-agent",
        created_at: new Date().toISOString(),
        response: response,
        marketSentimentResponse,
        done: false,
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      // Send final chunk to indicate completion
      const finalData = {
        model: process.env.AGENT_NAME || "default-agent",
        created_at: new Date().toISOString(),
        response: "",
        done: true,
      };
      res.write(`data: ${JSON.stringify(finalData)}\n\n`);
      res.end();
    } catch (error) {
      Logger.error("http", "Failed to handle chat message", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({
        error: { message: "Failed to process message" },
      });
    }
  })();
});

async function main() {
  try {
    // Initialize logger
    await Logger.init("agent", { useStdout: true });

    const p2pAddress = `localhost:${process.env.GRPC_PORT || "50051"}`;
    const p2pPort = parseInt(process.env.P2P_PORT || "8000");
    const httpPort = parseInt(process.env.HTTP_PORT || "3000");
    const agentId = process.env.AGENT_NAME || "default-agent";

    // Initialize P2P client
    client = new P2PClient({
      address: p2pAddress,
      binaryPath: process.env.P2P_NODE_PATH,
      timeout: 5000,
    });

    // Register message handler before connecting
    client.onMessage(handleMessage);

    // Connect to P2P network
    await client.connect({
      port: p2pPort,
      agentId: agentId,
    });

    // Start HTTP server
    app.listen(httpPort, () => {
      Logger.info("http", "HTTP server started", { port: httpPort });
    });

    Logger.info("agent", "Agent started", {
      agentId,
      p2pAddress,
      httpPort,
    });

    // Handle shutdown
    process.on("SIGINT", async () => {
      Logger.info("agent", "Shutting down");
      await client.disconnect();
      process.exit(0);
    });
  } catch (error) {
    Logger.error("agent", "Failed to start agent", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
