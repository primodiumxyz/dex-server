import { QuoteGetRequest } from "@jup-ag/api";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { interval, Subject, switchMap } from "rxjs";

import { Config } from "@/services/ConfigService";
import { FeeService } from "@/services/FeeService";
import { JupiterService } from "@/services/JupiterService";
import { TransactionService } from "@/services/TransactionService";
import {
  ActiveSwapRequest,
  PrebuildSwapResponse,
  SwapSubscription,
  TransactionRegistryData,
  TransactionType,
} from "@/types";
import { config } from "@/utils/config";

/**
 * Service for managing token swap operations and subscriptions
 *
 * Coordinates between Jupiter swap quotes, transaction building, and fee calculations
 */
export class SwapService {
  private swapSubscriptions: Map<string, SwapSubscription> = new Map();

  constructor(
    private jupiter: JupiterService,
    private transactionService: TransactionService,
    private feeService: FeeService,
  ) {}

  /**
   * Builds a swap response for a given request
   *
   * @param request - Active swap request containing token and user details
   * @param cfg - Configuration settings for the swap
   * @param buildAttempt - Number of attempts made to build this swap
   * @returns Promise resolving to prebuild swap response with transaction message
   * @throws Error if sell token account is missing, slippage is invalid, or swap instructions fail
   */
  async buildSwapResponse(
    request: ActiveSwapRequest,
    cfg: Config,
    buildAttempt: number,
  ): Promise<PrebuildSwapResponse> {
    if (!request.sellTokenAccount) {
      throw new Error("Sell token account is required but was not provided");
    }

    if (request.slippageBps && request.slippageBps > cfg.USER_SLIPPAGE_BPS_MAX) {
      throw new Error("Slippage bps is too high");
    }

    if (request.slippageBps && request.slippageBps < cfg.MIN_SLIPPAGE_BPS) {
      throw new Error("Slippage bps must be greater than " + cfg.MIN_SLIPPAGE_BPS);
    }

    // Determine swap type
    const transactionType = await this.transactionService.determineTransactionType(request);

    // Calculate fee if swap type is buy
    const buyFeeAmount =
      TransactionType.BUY === transactionType
        ? this.feeService.calculateFeeAmount(request.sellQuantity, transactionType, cfg)
        : 0;
    const swapAmount = request.sellQuantity - buyFeeAmount;

    // Create token account close instruction if swap type is sell_all (conditional occurs within function)
    const tokenCloseInstruction = await this.transactionService.createTokenCloseInstruction(
      request.userPublicKey,
      request.sellTokenAccount,
      new PublicKey(request.sellTokenId),
      request.sellQuantity,
      transactionType,
    );

    // there are 3 different forms of slippage settings, ordered by priority
    // 1. user provided slippage bps
    // 2. auto slippage set to true with a max slippage bps
    // 3. auto slippage set to false, use MAX_DEFAULT_SLIPPAGE_BPS

    const slippageSettings = {
      slippageBps: request.slippageBps
        ? request.slippageBps
        : cfg.AUTO_SLIPPAGE
          ? undefined
          : cfg.MAX_DEFAULT_SLIPPAGE_BPS,
      autoSlippage: request.slippageBps ? false : cfg.AUTO_SLIPPAGE,
      maxAutoSlippageBps: cfg.MAX_AUTO_SLIPPAGE_BPS,
      autoSlippageCollisionUsdValue: cfg.AUTO_SLIPPAGE_COLLISION_USD_VALUE,
    };

    // Get swap instructions from Jupiter
    // if slippageBps is provided, use it
    // if slippageBps is not provided, use autoSlippage if its true, otherwise use MAX_DEFAULT_SLIPPAGE_BPS
    const swapInstructionRequest: QuoteGetRequest = {
      inputMint: request.sellTokenId,
      outputMint: request.buyTokenId,
      amount: swapAmount,
      slippageBps: slippageSettings.slippageBps,
      autoSlippage: slippageSettings.autoSlippage,
      maxAutoSlippageBps: slippageSettings.maxAutoSlippageBps,
      autoSlippageCollisionUsdValue: slippageSettings.autoSlippageCollisionUsdValue,
      onlyDirectRoutes: false,
      restrictIntermediateTokens: true,
      maxAccounts: cfg.MAX_ACCOUNTS,
      asLegacyTransaction: false,
    };

    const {
      instructions: swapInstructions,
      addressLookupTableAccounts,
      quote,
    } = await this.jupiter.getSwapInstructions(swapInstructionRequest, request.userPublicKey);

    if (!swapInstructions?.length) {
      throw new Error("No swap instruction received");
    }

    let feeTransferInstruction: TransactionInstruction | null = null;

    // Create fee transfer instruction
    if (transactionType === TransactionType.BUY) {
      feeTransferInstruction = this.feeService.createFeeTransferInstruction(
        request.sellTokenAccount,
        request.userPublicKey,
        buyFeeAmount,
      );
    } else if (transactionType === TransactionType.SELL_ALL || transactionType === TransactionType.SELL_PARTIAL) {
      const sellFeeAmount = this.feeService.calculateFeeAmount(Number(quote.outAmount), transactionType, cfg);
      feeTransferInstruction = this.feeService.createFeeTransferInstruction(
        request.buyTokenAccount,
        request.userPublicKey,
        sellFeeAmount,
      );
    } else {
      throw new Error("Invalid swap type");
    }

    const organizedInstructions = this.organizeInstructions(
      swapInstructions,
      feeTransferInstruction,
      tokenCloseInstruction,
    );

    // Reassign rent payer in instructions
    const rentReassignedInstructions = this.transactionService.reassignRentInstructions(organizedInstructions);

    // estimate compute budget
    const optimizedInstructions = await this.transactionService.optimizeComputeInstructions(
      rentReassignedInstructions,
      addressLookupTableAccounts,
      quote.contextSlot ?? 0,
      cfg,
    );

    const txRegistryData: TransactionRegistryData = {
      timestamp: Date.now(),
      transactionType: transactionType,
      autoSlippage: slippageSettings.autoSlippage,
      contextSlot: quote.contextSlot ?? 0,
      buildAttempts: buildAttempt,
      activeSwapRequest: request,
      cfg: cfg,
    };

    // Build transaction message
    const base64Message = await this.transactionService.buildAndRegisterTransactionMessage(
      optimizedInstructions,
      addressLookupTableAccounts,
      txRegistryData,
    );

    const response: PrebuildSwapResponse = {
      transactionMessageBase64: base64Message,
      ...request,
      hasFee: !!feeTransferInstruction,
      timestamp: Date.now(),
    };

    return response;
  }

  /**
   * Organizes transaction instructions in the correct order
   *
   * @private
   * @param swapInstructions - Core swap instructions from Jupiter
   * @param feeTransferInstruction - Optional fee transfer instruction
   * @param tokenCloseInstruction - Optional token account close instruction
   * @returns Array of organized transaction instructions
   */
  private organizeInstructions(
    swapInstructions: TransactionInstruction[],
    feeTransferInstruction: TransactionInstruction | null,
    tokenCloseInstruction: TransactionInstruction | null,
  ): TransactionInstruction[] {
    const instructions = [...swapInstructions];
    if (feeTransferInstruction) {
      instructions.push(feeTransferInstruction);
    }
    if (tokenCloseInstruction) {
      instructions.push(tokenCloseInstruction);
    }
    return instructions;
  }

  /**
   * Retrieves a transaction message from the registry
   *
   * @param transactionMessageBase64 - Base64 encoded transaction message
   * @returns Registered transaction data
   */
  getMessageFromRegistry(transactionMessageBase64: string) {
    return this.transactionService.getRegisteredTransaction(transactionMessageBase64);
  }

  /**
   * Removes a transaction message from the registry
   *
   * @param transactionMessageBase64 - Base64 encoded transaction message to delete
   */
  deleteMessageFromRegistry(transactionMessageBase64: string) {
    this.transactionService.deleteFromRegistry(transactionMessageBase64);
  }

  /**
   * Checks if a user has an active swap stream
   *
   * @param userId - User identifier
   * @returns True if user has active stream, false otherwise
   */
  hasActiveStream(userId: string): boolean {
    return this.swapSubscriptions.has(userId);
  }

  /**
   * Gets the active swap request for a user, relevant for swap stream
   *
   * @param userId - User identifier
   * @returns Active swap request if exists, undefined otherwise
   */
  getActiveRequest(userId: string): ActiveSwapRequest | undefined {
    return this.swapSubscriptions.get(userId)?.request;
  }

  /**
   * Updates the active swap request for a user, relevant for swap stream
   *
   * @param userId - User identifier
   * @param request - New swap request
   * @throws Error if no active swap stream exists
   */
  updateActiveRequest(userId: string, request: ActiveSwapRequest): void {
    const subscription = this.swapSubscriptions.get(userId);
    if (!subscription) {
      throw new Error("No active swap stream found");
    }
    subscription.request = request;
  }

  /**
   * Starts a swap stream for a user that emits swap responses every second
   *
   * @deprecated Needs updating because of how swaps are now built and submitted
   * @param userId - User identifier
   * @param request - Initial swap request
   * @returns Subject that emits prebuild swap responses
   */
  async startSwapStream(userId: string, request: ActiveSwapRequest) {
    if (!this.swapSubscriptions.has(userId)) {
      const subject = new Subject<PrebuildSwapResponse>();

      // Create 1-second interval stream
      const subscription = interval(1000)
        .pipe(
          switchMap(async () => {
            const currentRequest = this.swapSubscriptions.get(userId)?.request;
            if (!currentRequest) return null;
            const cfg = await config();
            return this.buildSwapResponse(currentRequest, cfg, 0);
          }),
        )
        .subscribe((response: PrebuildSwapResponse | null) => {
          if (response) {
            subject.next(response);
          }
        });

      this.swapSubscriptions.set(userId, { subject, subscription, request });
    }

    return this.swapSubscriptions.get(userId)?.subject;
  }

  /**
   * Stops and cleans up a user's swap stream
   *
   * @param userId - User identifier
   */
  async stopSwapStream(userId: string) {
    const subscription = this.swapSubscriptions.get(userId);
    if (subscription) {
      subscription.subscription.unsubscribe();
      subscription.subject.complete();
      this.swapSubscriptions.delete(userId);
    }
  }
}
