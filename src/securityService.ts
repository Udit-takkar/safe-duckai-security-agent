import { SafeMultisigTransactionResponse } from "@safe-global/types-kit/dist/src/types";
import { ethers } from "ethers/lib.commonjs";
import { AddressListService } from "./utils/addressLists";
import { Logger } from "./utils/logger";
import { processSecurityReport, generateSecuritySummary } from "./agent";
import blacklist from "./utils/address.json";

const maxUint256 = 2n ** 256n - 1n;

interface SecurityCheck {
  safe: boolean;
  risk: "none" | "low" | "medium" | "high" | "critical";
  message: string;
}

interface SecurityChecks {
  addressPoisoning: SecurityCheck;
  valueTransfer: SecurityCheck;
  marketTiming: SecurityCheck;
  contractInteraction: SecurityCheck;
  knownScams: SecurityCheck;
  recentActivity: SecurityCheck;
  approvalRisks: SecurityCheck;
}

const VERIFIED_CONTRACTS = new Set([
  "0x00000000006c3852cbEf3e08E8dF289169EdE581",
  "0x7Be8076f4EA4A4AD08075C2508e481d6C946D12b",
]);

// Known high-risk contract patterns
const SUSPICIOUS_PATTERNS = {
  UNLIMITED_APPROVAL:
    /0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/i,
  POTENTIAL_PHISHING: /(claim|airdrop|free|reward|prize|giveaway)/i,
};

const SUSPICIOUS_SIGNATURES = {
  FAKE_TOKEN: "0xa9059cbb", // transfer()
  MALICIOUS_APPROVE: "0x095ea7b3", // approve()
  SUSPICIOUS_MINT: "0x40c10f19", // mint()
  INITIALIZE: "0x8129fc1c", // initialize()
};

const SECURITY_PATTERNS = {
  UNLIMITED_APPROVAL:
    /0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/i,
  POTENTIAL_PHISHING: /(claim|airdrop|free|reward|prize|giveaway)/i,
  FLASH_LOAN: /(flash|loan|borrow|lend)/i,
  BRIDGE_TRANSFER: /(bridge|cross.*chain|wormhole|stargate)/i,
  DELEGATE_CALL: /delegatecall/i,
  SELF_DESTRUCT: /(selfdestruct|suicide)/i,
  REENTRY: /(reentrant|reentrancy)/i,
  PROXY_UPGRADE: /(upgrade|implementation|proxy)/i,
  OWNERSHIP_TRANSFER: /(transfer.*ownership|new.*owner)/i,
};

const checkProxyRisks = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  if (!tx.data)
    return { safe: true, risk: "none", message: "No proxy risks detected" };

  // Check for proxy upgrade patterns
  if (SECURITY_PATTERNS.PROXY_UPGRADE.test(tx.data)) {
    return {
      safe: false,
      risk: "high",
      message: "Proxy upgrade detected - verify new implementation",
    };
  }

  // Check for initialization
  if (tx.data.includes(SUSPICIOUS_SIGNATURES.INITIALIZE)) {
    return {
      safe: false,
      risk: "high",
      message:
        "Contract initialization detected - potential proxy manipulation",
    };
  }

  return {
    safe: true,
    risk: "none",
    message: "No proxy risks detected",
  };
};

const checkAddressPoisoning = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  try {
    const addressListService = AddressListService.getInstance();
    const toAddress = tx.to.toLowerCase();
    const details: string[] = [];

    const isBlacklisted = blacklist.some(
      (addr: string) => addr.toLowerCase() === toAddress.toLowerCase()
    );

    if (isBlacklisted) {
      return {
        safe: false,
        risk: "critical",
        message:
          "Destination address is known to be malicious (MyEtherWallet darklist)",
      };
    }

    // 2. Check if it's a verified address
    if (addressListService.isLightlisted(toAddress)) {
      return {
        safe: true,
        risk: "none",
        message: "Destination address is verified (MyEtherWallet lightlist)",
      };
    }

    // Default case - no issues found
    return {
      safe: true,
      risk: "none",
      message: "No address poisoning risks detected",
    };
  } catch (error) {
    Logger.error("security", "Error in address poisoning check", {
      error: error instanceof Error ? error.message : String(error),
      address: tx.to,
    });
    return {
      safe: false,
      risk: "high",
      message: "Error checking address safety",
    };
  }
};

const checkContractAge = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const code = await provider.getCode(tx.to);

    if (code === "0x") {
      return {
        safe: true,
        risk: "none",
        message: "Not a contract address",
      };
    }

    const currentBlock = await provider.getBlockNumber();
    const txCount = await provider.getTransactionCount(tx.to);

    if (txCount < 100) {
      return {
        safe: false,
        risk: "high",
        message: "Contract has very low transaction count - potential risk",
      };
    }

    return {
      safe: true,
      risk: "none",
      message: "Contract has sufficient transaction history",
    };
  } catch (error) {
    return {
      safe: false,
      risk: "medium",
      message: "Unable to verify contract age",
    };
  }
};

// Helper function to check address similarity
const checkAddressSimilarity = async (
  address: string
): Promise<{ isSimilar: boolean; similarTo?: string }> => {
  const COMMON_CONTRACTS = new Map([
    ["0x7a250d5630b4cf539739df2c5dacb4c659f2488d", "Uniswap V2 Router"],
    ["0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", "Uniswap V3 Router"],
    ["0x00000000006c3852cbef3e08e8df289169ede581", "OpenSea Seaport"],
    // Add more common contracts
  ]);

  const addressLower = address.toLowerCase();

  // Check for exact matches first
  if (COMMON_CONTRACTS.has(addressLower)) {
    return { isSimilar: false }; // It's actually the legitimate contract
  }

  // Check for similar addresses
  for (const [knownAddress, name] of COMMON_CONTRACTS.entries()) {
    const similarity = calculateAddressSimilarity(addressLower, knownAddress);
    if (similarity > 0.9) {
      // 90% similar
      return {
        isSimilar: true,
        similarTo: name,
      };
    }
  }

  return { isSimilar: false };
};

// Helper function to calculate address similarity
const calculateAddressSimilarity = (addr1: string, addr2: string): number => {
  let matches = 0;
  const length = Math.min(addr1.length, addr2.length);

  for (let i = 0; i < length; i++) {
    if (addr1[i] === addr2[i]) matches++;
  }

  return matches / length;
};

const checkApprovalRisks = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  if (tx.dataDecoded?.method === "approve") {
    const amount = tx.dataDecoded.parameters[1].value;
    const tokenAddress = tx.dataDecoded.parameters[0].value;

    if (amount === maxUint256.toString()) {
      return {
        safe: false,
        risk: "high",
        message: "Infite Approval risk detected for token: " + tokenAddress,
      };
    }
  }

  return {
    safe: true,
    risk: "none",
    message: "No approval risks detected",
  };
};

const checkContractInteraction = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  if (!tx.data || tx.data === "0x") {
    return {
      safe: true,
      risk: "none",
      message: "Simple ETH transfer - no contract interaction",
    };
  }

  const functionSignature = tx.data.slice(0, 10);

  // Check if it's a verified contract
  if (VERIFIED_CONTRACTS.has(tx.to)) {
    return {
      safe: true,
      risk: "none",
      message: "Interaction with verified contract",
    };
  }

  // Check for suspicious function signatures
  if (Object.values(SUSPICIOUS_SIGNATURES).includes(functionSignature)) {
    return {
      safe: false,
      risk: "high",
      message: "Suspicious contract interaction detected",
    };
  }

  // Check for unlimited approvals
  if (tx.data.includes(SUSPICIOUS_PATTERNS.UNLIMITED_APPROVAL.source)) {
    return {
      safe: false,
      risk: "high",
      message: "Unlimited token approval detected",
    };
  }

  return {
    safe: true,
    risk: "low",
    message: "Contract interaction appears normal",
  };
};

const checkKnownScams = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  if (!tx.data) {
    return {
      safe: true,
      risk: "none",
      message: "No known scam patterns detected",
    };
  }

  if (SUSPICIOUS_PATTERNS.POTENTIAL_PHISHING.test(tx.data)) {
    return {
      safe: false,
      risk: "critical",
      message: "Transaction matches known scam patterns",
    };
  }

  const maliciousPatterns = [
    {
      pattern: /mint|claim|reward/i,
      message: "Suspicious token minting or claiming",
    },
    { pattern: /upgrade|migrate/i, message: "Suspicious upgrade or migration" },
    { pattern: /emergency|urgent/i, message: "Suspicious emergency action" },
  ];

  for (const { pattern, message } of maliciousPatterns) {
    if (pattern.test(tx.data)) {
      return {
        safe: false,
        risk: "high",
        message,
      };
    }
  }

  return {
    safe: true,
    risk: "none",
    message: "No known scam patterns detected",
  };
};

const checkValueTransfer = async (
  tx: SafeMultisigTransactionResponse
): Promise<SecurityCheck> => {
  const value = BigInt(tx.value);
  const thresholds = {
    low: BigInt("1000000000000000000"), // 1 ETH
    medium: BigInt("10000000000000000000"), // 10 ETH
    high: BigInt("50000000000000000000"), // 50 ETH
  };

  if (value > thresholds.high) {
    return {
      safe: false,
      risk: "high",
      message: `Very high value transfer detected (>${ethers.formatEther(
        thresholds.high
      )} ETH)`,
    };
  } else if (value > thresholds.medium) {
    return {
      safe: false,
      risk: "medium",
      message: `High value transfer detected (>${ethers.formatEther(
        thresholds.medium
      )} ETH)`,
    };
  } else if (value > thresholds.low) {
    return {
      safe: true,
      risk: "low",
      message: `Moderate value transfer detected (>${ethers.formatEther(
        thresholds.low
      )} ETH)`,
    };
  }

  return {
    safe: true,
    risk: "none",
    message: "Value transfer within safe limits",
  };
};

const analyzeTransaction = async (tx: SafeMultisigTransactionResponse) => {
  try {
    const [
      addressPoisoning,
      valueTransfer,
      contractInteraction,
      knownScams,
      approvalRisks,
    ] = await Promise.all([
      checkAddressPoisoning(tx),
      checkValueTransfer(tx),
      checkContractInteraction(tx),
      checkKnownScams(tx),
      checkApprovalRisks(tx),
    ]);

    const securityChecks = {
      addressPoisoning,
      valueTransfer,
      contractInteraction,
      knownScams,
      approvalRisks,
    };

    // Determine overall safety
    const criticalIssues = Object.values(securityChecks).filter(
      (check) => check.risk === "critical"
    );
    const highRiskIssues = Object.values(securityChecks).filter(
      (check) => check.risk === "high"
    );
    const mediumRiskIssues = Object.values(securityChecks).filter(
      (check) => check.risk === "medium"
    );

    const isSafe = criticalIssues.length === 0 && highRiskIssues.length === 0;

    // Generate AI analysis of the security checks
    const aiReport = await processSecurityReport(tx, securityChecks);

    Logger.info("security", "Transaction analysis complete", {
      txHash: tx.transactionHash,
      isSafe,
      criticalIssues: criticalIssues.length,
      highRiskIssues: highRiskIssues.length,
      mediumRiskIssues: mediumRiskIssues.length,
    });

    return {
      safe: isSafe,
      securityChecks,
      aiAnalysis: aiReport,
      summary: generateSecuritySummary(securityChecks),
    };
  } catch (error) {
    Logger.error("security", "Failed to analyze transaction", {
      error: error instanceof Error ? error.message : String(error),
      tx: tx.transactionHash,
    });
    throw error;
  }
};

const securityService = {
  analyzeTransaction,
};

export default securityService;
