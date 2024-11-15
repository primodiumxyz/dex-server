import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { TubService } from "./TubService";
import { observable } from '@trpc/server/observable';
import { PublicKey } from "@solana/web3.js";

export type AppContext = {
  tubService: TubService;
  jwtToken: string;
};

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
/**
 * Creates and configures the main tRPC router with all API endpoints.
 * @returns A configured tRPC router with all procedures
 */
export function createAppRouter() {
  const t = initTRPC.context<AppContext>().create();
  return t.router({
    /**
     * Health check endpoint that returns server status
     * @returns Object containing status code 200 if server is healthy
     */
    getStatus: t.procedure.query(({ ctx }) => {
      return ctx.tubService.getStatus();
    }),

    /**
     * Purchases a specified amount of tokens
     * @param tokenId - The unique identifier of the token to buy
     * @param amount - The amount of tokens to purchase as a string (will be converted to BigInt)
     * @param overridePrice - Optional override price for the token purchase
     * @returns Result of the token purchase operation
     */
    buyToken: t.procedure
      .input(
        z.object({
          tokenId: z.string(),
          amount: z.string(),
          overridePrice: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.tubService.buyToken(
          ctx.jwtToken,
          input.tokenId,
          BigInt(input.amount),
          input.overridePrice ? BigInt(input.overridePrice) : undefined,
        );
      }),

    /**
     * Sells a specified amount of tokens
     * @param tokenId - The unique identifier of the token to sell
     * @param amount - The amount of tokens to sell as a string (will be converted to BigInt)
     * @param overridePrice - Optional override price for the token sale
     * @returns Result of the token sale operation
     */
    sellToken: t.procedure
      .input(
        z.object({
          tokenId: z.string(),
          amount: z.string(),
          overridePrice: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.tubService.sellToken(
          ctx.jwtToken,
          input.tokenId,
          BigInt(input.amount),
          input.overridePrice ? BigInt(input.overridePrice) : undefined,
        );
      }),

    airdropNativeToUser: t.procedure
      .input(
        z.object({
          amount: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.tubService.airdropNativeToUser(ctx.jwtToken, BigInt(input.amount));
      }),
    recordClientEvent: t.procedure
      .input(
        z.object({
          userAgent: z.string(),
          eventName: z.string(),
          buildVersion: z.string().optional(),
          metadata: z.string().optional(),
          errorDetails: z.string().optional(),
          source: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await ctx.tubService.recordClientEvent(input, ctx.jwtToken);
      }),
    /**
     * Creates a subscription stream for token swaps
     * @param buyTokenId - The token ID to buy
     * @param sellTokenId - The token ID to sell
     * @param sellQuantity - The amount of tokens to sell
     * @param userPublicKey - The user's Solana public key
     * @returns Observable stream of base64-encoded transactions
     * @throws Error if public key is invalid or token IDs are missing
     */
    swapStream: t.procedure
      .input(z.object({
        buyTokenId: z.string().optional(),
        sellTokenId: z.string().optional(),
        sellQuantity: z.number().optional(),
        userPublicKey: z.string()
      }))
      .subscription(({ ctx, input }) => {
        // Validate the public key before proceeding
        try {
          new PublicKey(input.userPublicKey);
        } catch (e) {
          throw new Error('Invalid user public key');
        }

        // Validate that we have both buy and sell token
        if (!input.buyTokenId || !input.sellTokenId) {
          throw new Error('Must provide both buyTokenId and sellTokenId');
        }

        return observable((emit) => {
          let subscription: any;
          
          ctx.tubService.startSwapStream(ctx.jwtToken, {
            ...input,
            userId: ctx.jwtToken,
            userPublicKey: new PublicKey(input.userPublicKey)
          }).then(subject => {
            subscription = subject.subscribe({
              next: (base64Transaction: string) => {
                emit.next(base64Transaction);
              },
              error: (error: Error) => {
                console.error('Swap stream error:', error);
                emit.error(error);
              }
            });
          }).catch(error => {
            console.error('Failed to start swap stream:', error);
            emit.error(error);
          });

          return () => {
            if (subscription) subscription.unsubscribe();
            ctx.tubService.stopSwapStream(ctx.jwtToken);
          };
        });
      }),

    /**
     * Updates an existing swap request with new parameters
     * @param buyTokenId - Optional new token ID to buy
     * @param sellTokenId - Optional new token ID to sell
     * @param sellQuantity - Optional new quantity to sell
     */
    updateSwapRequest: t.procedure
      .input(z.object({
        buyTokenId: z.string().optional(),
        sellTokenId: z.string().optional(),
        sellQuantity: z.number().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        await ctx.tubService.updateSwapRequest(ctx.jwtToken, input);
      }),

    /**
     * Submits a signed transaction for processing
     * @param signature - The user's signature for the transaction
     * @param base64Transaction - The base64-encoded transaction (before signing) to submit. Came from swapStream
     * @returns Object containing the transaction signature if successful
     * @throws Error if transaction processing fails
     */
    submitSignedTransaction: t.procedure
      .input(z.object({
        signature: z.string(),
        base64Transaction: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        await ctx.tubService.signAndSendTransaction(
          ctx.jwtToken,
          input.signature,
          input.base64Transaction
        );
      }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
