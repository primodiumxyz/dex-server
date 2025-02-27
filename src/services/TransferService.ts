import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";

import { TOKEN_ACCOUNT_SIZE, USDC_MAINNET_PUBLIC_KEY } from "@/constants/tokens";
import { FeeService } from "@/services/FeeService";
import { TransactionService } from "@/services/TransactionService";
import { TransactionType } from "@/types";

export interface TransferRequest {
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  tokenId: string;
}

export interface SignedTransfer {
  transactionMessageBase64: string;
  signatureBase64: string;
  signerBase58: string;
}

/**
 * Service for handling token transfer operations
 *
 * Manages SOL and SPL token transfers, including ATA creation and fee calculations
 */
export class TransferService {
  /**
   * Creates a new TransferService instance
   *
   * @param connection - Solana RPC connection
   * @param feePayerKeypair - Keypair used for paying transaction fees
   * @param transactionService - Service for transaction operations
   * @param feeService - Service for fee calculations
   */
  constructor(
    private connection: Connection,
    private feePayerKeypair: Keypair,
    private transactionService: TransactionService,
    private feeService: FeeService,
  ) {}

  /**
   * Builds and registers a transfer transaction
   *
   * @param request - Transfer request containing from/to addresses and amount
   * @returns Promise resolving to base64 encoded transaction message
   * @throws Error if transfer request is invalid, insufficient balance, or ATA creation fails
   */
  async getTransfer(request: TransferRequest): Promise<{ transactionMessageBase64: string }> {
    let transferInstruction: TransactionInstruction;
    let computeUnitLimitInstruction: TransactionInstruction | null = null;
    let computeUnitPriceInstruction: TransactionInstruction | null = null;
    let createATAInstruction: TransactionInstruction | null = null;
    let createATAFeeInstruction: TransactionInstruction | null = null;

    // Handle SOL transfers
    if (request.tokenId === "SOLANA") {
      transferInstruction = SystemProgram.transfer({
        fromPubkey: new PublicKey(request.fromAddress),
        toPubkey: new PublicKey(request.toAddress),
        lamports: request.amount,
      });
    }
    // Handle USDC transfers
    else if (request.tokenId === USDC_MAINNET_PUBLIC_KEY.toString()) {
      const tokenMint = new PublicKey(request.tokenId);
      const fromPublicKey = new PublicKey(request.fromAddress);
      const toPublicKey = new PublicKey(request.toAddress);

      const fromTokenAccount = getAssociatedTokenAddressSync(tokenMint, fromPublicKey);
      const toTokenAccount = getAssociatedTokenAddressSync(tokenMint, toPublicKey);

      // Check if destination ATA needs to be created
      const toTokenAccountSolBalance = await this.connection.getBalance(toTokenAccount, "processed");
      const fromTokenAccountUsdcBalance = await this.connection.getTokenAccountBalance(fromTokenAccount);

      if (toTokenAccountSolBalance === 0) {
        createATAInstruction = createAssociatedTokenAccountInstruction(
          this.feePayerKeypair.publicKey, // fee payer
          toTokenAccount, // New account destination being created
          toPublicKey, // destination public key
          tokenMint, // token mint
        );

        // Calculate and verify rent exemption fee
        const rentExemptionAmountLamports = await this.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);
        const rentExemptionFeeAmountUsdcBaseUnits =
          await this.feeService.calculateRentExemptionFeeAmount(rentExemptionAmountLamports);

        if (Number(fromTokenAccountUsdcBalance.value.amount) < rentExemptionFeeAmountUsdcBaseUnits) {
          throw new Error("Insufficient USDC balance to cover Solana rent exemption fee");
        }

        createATAFeeInstruction = this.feeService.createFeeTransferInstruction(
          fromTokenAccount,
          fromPublicKey,
          rentExemptionFeeAmountUsdcBaseUnits,
        );
      }

      transferInstruction = createTransferInstruction(fromTokenAccount, toTokenAccount, fromPublicKey, request.amount);

      computeUnitLimitInstruction = ComputeBudgetProgram.setComputeUnitLimit({
        units: 40000,
      });

      computeUnitPriceInstruction = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 100000,
      });
    } else {
      throw new Error("Invalid transfer request");
    }

    const slot = await this.connection.getSlot("finalized");
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("finalized");

    // Filter and organize instructions
    const allInstructions = [
      computeUnitLimitInstruction,
      computeUnitPriceInstruction,
      createATAInstruction,
      transferInstruction,
      createATAFeeInstruction,
    ].filter((instruction) => instruction !== undefined && instruction !== null);

    // Build and compile transaction message
    const message = new TransactionMessage({
      payerKey: this.feePayerKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: allInstructions,
    }).compileToV0Message([]);

    // Register transaction
    const base64Message = this.transactionService.registerTransaction(
      message,
      lastValidBlockHeight,
      TransactionType.TRANSFER,
      false,
      slot,
      1,
    );

    return {
      transactionMessageBase64: base64Message,
    };
  }
}
