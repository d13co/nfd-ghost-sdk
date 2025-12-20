import { AlgorandClient } from "@algorandfoundation/algokit-utils"
import { chunked } from "./utils/chunked.js"
import { NfdNano, NfdReaderSDK, NfdTiny } from "./generated/NfdReaderSDK.js"
import pMap from "p-map"
import { ALGORAND_ZERO_ADDRESS_STRING } from "algosdk"

export class NfdGhostSDK {
  static baseSDK = NfdReaderSDK

  public algorand: AlgorandClient
  public registryAppId: bigint
  public baseSDK: NfdReaderSDK
  public methodConcurrency: number
  public boxReadConcurrency: number

  constructor({
    algorand,
    registryAppId,
    methodConcurrency = 4,
    boxReadConcurrency = 8,
    ghostAppId,
  }: {
    algorand: AlgorandClient
    methodConcurrency?: number
    boxReadConcurrency?: number
    registryAppId: number | bigint
    ghostAppId?: bigint
  }) {
    this.algorand = algorand
    this.registryAppId = BigInt(registryAppId)
    this.methodConcurrency = methodConcurrency
    this.boxReadConcurrency = boxReadConcurrency
    this.baseSDK = new NfdReaderSDK({
      algorand: this.algorand,
      readerAccount: "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA",
      ghostAppId,
    })
  }

  @chunked(128)
  async getVersionsFromAppIds(appIds: number[] | bigint[]): Promise<string[]> {
    return this.baseSDK.getVersionsFromAppIds({
      methodArgsOrArgsArray: { appIds },
    })
  }

  @chunked(128)
  async getNanoViewFromAppIds(appIds: number[] | bigint[]): Promise<NfdNano[]> {
    return this.baseSDK.getNanoViewFromAppIds({
      methodArgsOrArgsArray: { appIds },
    })
  }

  @chunked(256)
  async getTinyViewFromAppIds(appIds: number[] | bigint[]): Promise<NfdTiny[]> {
    appIds = appIds.map((id) => BigInt(id))

    const versions = await this.getVersionsFromAppIds(appIds)

    const [v2AppIds, v3AppIds] = appIds.reduce(
      ([v2, v3], appId, idx) => {
        const version = versions[idx]
        if (version.startsWith("2")) {
          v2.push(appId)
        } else if (version.startsWith("3")) {
          v3.push(appId)
        } else {
          throw new Error(`Unsupported NFD version for app ID ${appId}: ${version}`)
        }
        return [v2, v3]
      },
      [[], []] as [bigint[], bigint[]],
    )

    const v3ResultsPromise = v3AppIds.length > 0 ? this.getTinyViewFromAppIdsV3(v3AppIds) : []
    const v2ResultsPromise = v2AppIds.length > 0 ? this.getTinyViewFromAppIdsV2(v2AppIds) : []
    const [v3Results, v2Results] = await Promise.all([v3ResultsPromise, v2ResultsPromise])

    // merge results back into original order
    let v2Index = 0
    let v3Index = 0
    const tinyViews: NfdTiny[] = []
    for (const appId of appIds) {
      const version = versions[tinyViews.length]
      if (version.startsWith("2")) {
        tinyViews.push(v2Results[v2Index])
        v2Index++
      } else if (version.startsWith("3")) {
        tinyViews.push(v3Results[v3Index])
        v3Index++
      }
    }
    return tinyViews
  }

  @chunked(36)
  async getTinyViewFromAppIdsV3(appIds: number[] | bigint[]): Promise<NfdTiny[]> {
    const extraFee = (appIds.length * 2000).microAlgo()
    return filterZeroAddresses(
      await this.baseSDK.getTinyViewFromAppIds({
        methodArgsOrArgsArray: { appIds },
        extraMethodCallArgs: { extraFee },
      }),
    )
  }

  @chunked(40)
  async getTinyViewFromAppIdsV2(appIds: number[] | bigint[]): Promise<NfdTiny[]> {
    // v2 needs assistance: fetch boxes for v2 app IDs
    // call v2 with hints
    const extraFee = (appIds.length * 2000).microAlgo()
    const v2Boxes = await pMap(
      appIds.map((id) => BigInt(id)),
      async (appId) => {
        const boxNames = (await this.algorand.app.getBoxNames(BigInt(appId))).map((bn) => bn.name)
        return {
          appId: BigInt(appId),
          hasVerifiedCaAlgoBox: boxNames.includes("v.caAlgo.0.as"),
          hasUnverifiedCaAlgoBox: boxNames.includes("u.caalgo"),
        }
      },
      { concurrency: this.boxReadConcurrency },
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
    return filterZeroAddresses(
      await this.baseSDK.getTinyViewFromAppIdsV2({
        methodArgsOrArgsArray: { arg: callArgs },
        extraMethodCallArgs: { extraFee },
      }),
    )
  }
}

function filterZeroAddresses(tinyView: NfdTiny[]): NfdTiny[] {
  return tinyView.map((tv) => ({
    ...tv,
    caAlgo: tv.caAlgo.filter((address) => address !== ALGORAND_ZERO_ADDRESS_STRING),
    unverifiedCaAlgo: tv.unverifiedCaAlgo.filter((address) => address !== ALGORAND_ZERO_ADDRESS_STRING),
  }))
}
