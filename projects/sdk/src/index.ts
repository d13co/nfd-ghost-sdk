import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { chunked } from "./utils/chunked.js"
import { NfdNano, NfdReaderSDK, NfdTiny } from "./generated/NfdReaderSDK.js"
import pMap from "p-map"

export class NfdGhostSDK {
  static baseSDK = NfdReaderSDK

  public algorand: AlgorandClient
  public registryAppId: bigint
  public baseSDK: NfdReaderSDK
  public concurrency: number
  public boxConcurrency: number

  constructor({
    algorand,
    registryAppId,
    concurrency = 4,
    boxConcurrency = 4,
    ghostAppId,
  }: {
    algorand: AlgorandClient
    concurrency?: number
    boxConcurrency?: number
    registryAppId: number | bigint
    ghostAppId?: bigint
  }) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.concurrency = concurrency
    this.boxConcurrency = boxConcurrency
    this.baseSDK = new NfdReaderSDK({
      algorand: this.algorand,
      readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
      ghostAppId,
    })
  }

  @chunked(128)
  async getNamesFromAppIds(appIds: number[] | bigint[]): Promise<string[]> {
    return this.baseSDK.getNamesFromAppIds({
      methodArgsOrArgsArray: { appIds },
    })
  }

  @chunked(128)
  async getNanoViewFromAppIds(appIds: number[] | bigint[]): Promise<NfdNano[]> {
    return this.baseSDK.getNanoViewFromAppIds({
      methodArgsOrArgsArray: { appIds },
    })
  }

  @chunked(128)
  async getTinyViewFromAppIds(appIds: number[] | bigint[]): Promise<NfdTiny[]> {
    // fetch v3 and v2 mixed
    // v2 will be missing caAlgo fields
    const tinyViews = await this.getTinyViewFromAppIdsV3(appIds)

    // v2 needs assistance: fetch boxes for v2 app IDs
    const v2AppIds = appIds.filter((appId, idx) => {
      const tinyView = tinyViews[idx]
      return tinyView.version.startsWith("2")
    })

    // call v2 with hints
    const v2Results = await this.getTinyViewFromAppIdsV2(v2AppIds.map((id) => BigInt(id)))

    // replace results for v2 app IDs
    for (let i = 0; i < v2AppIds.length; i++) {
      const appId = v2AppIds[i]
      const v2Result = v2Results[i]
      const mainResultIdx = appIds.findIndex((id) => BigInt(id) === BigInt(appId))
      tinyViews[mainResultIdx] = v2Result
    }
    return tinyViews
  }

  @chunked(40)
  async getTinyViewFromAppIdsV3(appIds: number[] | bigint[]): Promise<NfdTiny[]> {
    const extraFee = (appIds.length * 2000).microAlgo()
    return this.baseSDK.getTinyViewFromAppIds({
      methodArgsOrArgsArray: { appIds },
      extraMethodCallArgs: { extraFee },
    })
  }

  @chunked(40)
  async getTinyViewFromAppIdsV2(v2AppIds: number[] | bigint[]): Promise<NfdTiny[]> {
    const extraFee = (v2AppIds.length * 2000).microAlgo()
    const v2Boxes = await pMap(
      v2AppIds.map((id) => BigInt(id)),
      async (appId) => {
        const boxNames = await this.algorand.app.getBoxNames(BigInt(appId))
        const names = boxNames.map((bn) => bn.name)
        return {
          appId: BigInt(appId),
          hasVerifiedCaAlgoBox: names.includes("v.caAlgo.0.as"),
          hasUnverifiedCaAlgoBox: names.includes("v.unverifiedCaAlgo.0.as"),
        }
      },
      { concurrency: this.boxConcurrency },
    )
    const callArgs = v2Boxes.reduce(
      (acc, curr) => {
        acc.appIds.push(curr.appId)
        acc.boxHints.hasVerifiedCaAlgoBox.push(curr.hasVerifiedCaAlgoBox)
        acc.boxHints.hasUnverifiedCaAlgoBox.push(curr.hasUnverifiedCaAlgoBox)
        return acc
      },
      {
        appIds: [] as bigint[],
        boxHints: {
          hasVerifiedCaAlgoBox: [] as boolean[],
          hasUnverifiedCaAlgoBox: [] as boolean[],
        },
      },
    )
    return this.baseSDK.getTinyViewFromAppIdsV2({
      methodArgsOrArgsArray: { arg: callArgs },
      extraMethodCallArgs: { extraFee },
    })
  }
}
