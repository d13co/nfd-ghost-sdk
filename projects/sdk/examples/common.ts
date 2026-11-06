import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { NfdGhostSDK } from "../src/index.js"

/** The local MainNet query node by default; set ALGOD_SERVER / ALGOD_PORT / ALGOD_TOKEN for another. */
export const algorand = AlgorandClient.fromConfig({
  algodConfig: {
    server: process.env.ALGOD_SERVER ?? "http://127.0.0.1",
    port: process.env.ALGOD_PORT ?? 8080,
    token: process.env.ALGOD_TOKEN ?? "",
  },
})

export const MAINNET_REGISTRY = 760937186n

export const sdk = new NfdGhostSDK({ algorand, registryAppId: MAINNET_REGISTRY, debug: !!process.env.DEBUG })

export const short = (a: string) => a.slice(0, 8)
