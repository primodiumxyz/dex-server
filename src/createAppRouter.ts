import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { Subject } from "rxjs";
import { z } from "zod";

import { Service } from "@/services/Service";
import { PrebuildSwapResponse, UserPrebuildSwapRequest } from "@/types";

/**
 * Context type for the tRPC router containing required services and auth
 */
export type AppContext = {
  service: Service;
  jwtToken: string;
};

/**
 * Zod schema for validating swap requests
 *
 * @see UserPrebuildSwapRequest
 */
const swapRequestSchema = z.object({
  buyTokenId: z.string(),
  sellTokenId: z.string(),
  sellQuantity: z.number(),
}) satisfies z.ZodType<UserPrebuildSwapRequest>;

/**
 * Creates and configures the main tRPC router with all API endpoints.
 *
 * @returns A configured tRPC router with all procedures
 */
export function createAppRouter() {
  const t = initTRPC.context<AppContext>().create();
  return t.router({
    /**
     * Health check endpoint that returns server status
     *
     * @returns {Promise<{ status: number }>} Object containing status code 200 if server is healthy
     */
    getStatus: t.procedure.query(({ ctx }) => {
      return ctx.service.getStatus();
    }),

    /**
     * Gets the current SOL/USD price
     *
     * @returns {Promise<number>} Current SOL price in USD
     */
    getSolUsdPrice: t.procedure.query(async ({ ctx }) => {
      return await ctx.service.getSolUsdPrice();
    }),

    /**
     * Creates a real-time subscription to SOL/USD price updates
     *
     * @returns {Observable<number>} Stream of SOL/USD price updates
     */
    subscribeSolPrice: t.procedure.subscription(({ ctx }) => {
      return observable<number>((emit) => {
        const onPrice = (price: number) => {
          emit.next(price);
        };
        const cleanup = ctx.service.subscribeSolPrice(onPrice);
        return () => {
          cleanup();
        };
      });
    }),

    /**
     * Creates a subscription stream for swap quotes
     *
     * @deprecated Use fetchSwap instead for one-time quotes
     * @param request - Swap request parameters
     * @param request.buyTokenId - Token mint address to buy
     * @param request.sellTokenId - Token mint address to sell
     * @param request.sellQuantity - Amount to sell in base units
     * @returns {Observable<PrebuildSwapResponse>} Stream of swap quotes and transactions
     */
    swapStream: t.procedure.input(z.object({ request: swapRequestSchema })).subscription(async ({ ctx, input }) => {
      return observable<PrebuildSwapResponse>((emit) => {
        let subject: Subject<PrebuildSwapResponse> | undefined;
        let cleanup: (() => void) | undefined;

        ctx.service
          .startSwapStream(ctx.jwtToken, input.request)
          .then((s) => {
            if (!s) {
              emit.error(new Error("Failed to start swap stream"));
              return;
            }

            subject = s;
            const subscription = subject.subscribe({
              next: (response: PrebuildSwapResponse) => {
                emit.next(response);
              },
              error: (error: Error) => {
                emit.error(error);
              },
              complete: () => {
                emit.complete();
              },
            });

            cleanup = () => {
              subscription.unsubscribe();
              subject?.complete();
            };
          })
          .catch((error) => {
            emit.error(error);
          });

        return () => {
          cleanup?.();
        };
      });
    }),

    /**
     * Creates a subscription stream for token swaps
     *
     * @param buyTokenId - The token ID to buy
     * @param sellTokenId - The token ID to sell
     * @param sellQuantity - The amount of tokens to sell
     * @param userPublicKey - The user's Solana public key
     * @returns Observable stream of base64-encoded transactions
     * @throws Error if public key is invalid or token IDs are missing
     */
    startSwapStream: t.procedure
      .input(
        z.object({
          buyTokenId: z.string(),
          sellTokenId: z.string(),
          sellQuantity: z.number(),
        }),
      )
      .subscription(({ ctx, input }) => {
        return observable((emit) => {
          let subject = null;

          ctx.service
            .startSwapStream(ctx.jwtToken, input)
            .then((s) => {
              if (!s) {
                emit.error(new Error("Failed to start swap stream"));
                return;
              }
              subject = s;
              if (subject) {
                subject.subscribe({
                  next: (response: PrebuildSwapResponse) => {
                    emit.next(response);
                  },
                  error: (error: Error) => {
                    console.error("Swap stream error:", error);
                    emit.error(error);
                  },
                });
              }
            })
            .catch((error) => {
              console.error("Failed to start swap stream:", error);
              emit.error(error);
            });

          return () => {
            ctx.service.stopSwapStream(ctx.jwtToken).catch(console.error);
          };
        });
      }),

    /**
     * Updates an existing swap request with new parameters
     *
     * @param buyTokenId - Optional new token ID to buy
     * @param sellTokenId - Optional new token ID to sell
     * @param sellQuantity - Optional new quantity to sell
     */
    updateSwapRequest: t.procedure
      .input(
        z.object({
          buyTokenId: z.string(),
          sellTokenId: z.string(),
          sellQuantity: z.number(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.service.updateSwapRequest(ctx.jwtToken, input);
      }),

    /**
     * Submits a signed transaction for processing
     *
     * @param signature - The user's signature for the transaction
     * @param base64Transaction - The base64-encoded transaction (before signing) to submit. Came from swapStream
     * @returns Object containing the transaction signature if successful
     * @throws Error if transaction processing fails
     */
    submitSignedTransaction: t.procedure
      .input(
        z.object({
          signature: z.string(),
          base64Transaction: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.service.signAndSendTransaction(ctx.jwtToken, input.signature, input.base64Transaction);
      }),

    /**
     * Fetches a one-time swap quote and transaction
     *
     * @param buyTokenId - Token mint address to buy
     * @param sellTokenId - Token mint address to sell
     * @param sellQuantity - Amount to sell in base units
     * @param slippageBps - Optional slippage tolerance in basis points
     * @returns {Promise<PrebuildSwapResponse>} Swap quote and transaction
     */
    fetchSwap: t.procedure
      .input(
        z.object({
          buyTokenId: z.string(),
          sellTokenId: z.string(),
          sellQuantity: z.number(),
          slippageBps: z.number().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return await ctx.service.fetchSwap(ctx.jwtToken, input);
      }),

    /**
     * Fetches a pre-signed swap transaction
     *
     * @param buyTokenId - Token mint address to buy
     * @param sellTokenId - Token mint address to sell
     * @param sellQuantity - Amount to sell in base units
     * @returns {Promise<PrebuildSwapResponse>} Pre-signed swap transaction
     */
    fetchPresignedSwap: t.procedure
      .input(
        z.object({
          buyTokenId: z.string(),
          sellTokenId: z.string(),
          sellQuantity: z.number(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return await ctx.service.fetchPresignedSwap(ctx.jwtToken, input);
      }),

    /**
     * Stops an active swap stream for the current user
     *
     * @returns {Promise<void>}
     */
    stopSwapStream: t.procedure.mutation(async ({ ctx }) => {
      await ctx.service.stopSwapStream(ctx.jwtToken);
    }),

    /**
     * Gets the user's SOL balance
     *
     * @returns {Promise<number>} Balance in lamports
     */
    getSolBalance: t.procedure.query(async ({ ctx }) => {
      return await ctx.service.getSolBalance(ctx.jwtToken);
    }),

    /**
     * Gets balances for all tokens in user's wallet
     *
     * @returns {Promise<{ mint: string; amount: string }[]>} Array of token balances
     */
    getAllTokenBalances: t.procedure.query(async ({ ctx }) => {
      return await ctx.service.getAllTokenBalances(ctx.jwtToken);
    }),

    /**
     * Gets balance for a specific token
     *
     * @param tokenMint - Token mint address to check
     * @returns {Promise<string>} Token balance in base units
     */
    getTokenBalance: t.procedure
      .input(
        z.object({
          tokenMint: z.string(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return await ctx.service.getTokenBalance(ctx.jwtToken, input.tokenMint);
      }),

    /**
     * Gets the estimated fee for a token transfer
     *
     * @returns {Promise<number>} Estimated fee in lamports
     */
    getEstimatedTransferFee: t.procedure.query(async ({ ctx }) => {
      return await ctx.service.getEstimatedTransferFee(ctx.jwtToken);
    }),

    /**
     * Fetches a transfer transaction for signing
     *
     * @param toAddress - Recipient address
     * @param amount - Amount to transfer in base units
     * @param tokenId - Token mint address
     * @returns {Promise<string>} Base64 encoded transaction
     */
    fetchTransferTx: t.procedure
      .input(
        z.object({
          toAddress: z.string(),
          amount: z.string(),
          tokenId: z.string(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return await ctx.service.fetchTransferTx(ctx.jwtToken, input);
      }),

    /**
     * Starts price tracking live activity for iOS
     *
     * @param tokenMint - Token to track
     * @param tokenPriceUsd - Initial token price
     * @param deviceToken - iOS device token
     * @param pushToken - APNS push token
     * @returns {Promise<{ success: boolean }>} Success status
     */
    startLiveActivity: t.procedure
      .input(
        z.object({
          tokenMint: z.string(),
          tokenPriceUsd: z.string(),
          deviceToken: z.string(),
          pushToken: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await ctx.service.startLiveActivity(ctx.jwtToken, input);
        return { success: true };
      }),

    /**
     * Stops price tracking live activity for iOS
     *
     * @returns {Promise<{ success: boolean }>} Success status
     */
    stopLiveActivity: t.procedure.mutation(async ({ ctx }) => {
      await ctx.service.stopLiveActivity(ctx.jwtToken);
      return { success: true };
    }),
  });
}

/**
 * Type definition for the complete tRPC router
 *
 * Generated from createAppRouter function
 */
export type AppRouter = ReturnType<typeof createAppRouter>;
