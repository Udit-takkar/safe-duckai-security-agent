import OpenAI from "openai";
import { Logger } from "./utils/logger";
import Safe, {
  PredictedSafeProps,
  SafeAccountConfig,
} from "@safe-global/protocol-kit";
import { sepolia } from "viem/chains";
import { ethers } from "ethers";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS;
const SAFE_ADDRESS = process.env.SAFE_ADDRESS;
const HUMAN_SIGNER_1_ADDRESS = process.env.HUMAN_SIGNER_1_ADDRESS;
const RPC_URL = "https://rpc.ankr.com/eth_sepolia";

async function initializeSafeAccount() {
  const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY;

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

  const safe = await Safe.init({
    provider: RPC_URL,
    signer: SIGNER_PRIVATE_KEY,
    predictedSafe,
  });

  return safe;
}

export async function processMessage(content: string): Promise<string> {
  try {
    const news = "";
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant that analyzes transactions on the blockchain.
          Here is the news: ${JSON.stringify(
            news
          )} Return a simple bullish or bearish sentiment with a 1-2 line summary of the news.`,
        },

        { role: "user", content },
      ],
      model: "gpt-3.5-turbo",
    });

    return completion.choices[0].message.content || "No response generated";
  } catch (error) {
    Logger.error("llm", "Failed to process message with OpenAI", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "Sorry, I encountered an error processing your message.";
  }
}
