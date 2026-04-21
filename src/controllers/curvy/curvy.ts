import EventEmitter from '../eventEmitter/eventEmitter'
import type { KeystoreController } from '../keystore/keystore'
import type { NetworksController } from '../networks/networks'
import type { SelectedAccountController } from '../selectedAccount/selectedAccount'
import { hostFactory } from '../privacyPools/hostFactory'

export type CurvyStatus = 'idle' | 'initializing' | 'ready' | 'error'

export class CurvyController extends EventEmitter {
  #keystore: KeystoreController

  #networks: NetworksController

  #selectedAccount: SelectedAccountController

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #plugin: any = null

  #initializing = false

  curvyId: string | null = null

  balance: any[] = []

  status: CurvyStatus = 'idle'

  error: string | null = null

  lastResult: any = null

  constructor(
    keystore: KeystoreController,
    networks: NetworksController,
    selectedAccount: SelectedAccountController
  ) {
    super()
    this.#keystore = keystore
    this.#networks = networks
    this.#selectedAccount = selectedAccount
  }

  async init(params: {
    curvyId?: string
    environment?: 'mainnet' | 'testnet'
    chainId?: bigint
    apiBaseUrl?: string
  }): Promise<void> {
    if (this.#initializing) return

    this.#initializing = true
    this.status = 'initializing'
    this.error = null
    this.emitUpdate()

    try {
      // Dynamic import so the heavy WASM/snarkjs bundle is NOT pulled into
      // the background service worker at startup — only loaded on demand.
      const mod = await import('@kohaku-eth/curvy')

      // Access the export in its own try-catch: if a previous import attempt
      // failed, webpack caches a broken module whose re-export getters throw
      // a misleading TypeError instead of the real error. Detect this and
      // surface a more actionable message.
      let createCurvyPlugin: typeof mod.createCurvyPlugin
      try {
        ;({ createCurvyPlugin } = mod)
      } catch {
        throw new Error(
          '@kohaku-eth/curvy module is in a broken state (a dependency likely failed to ' +
            'initialize in the service worker). Reload the extension to retry.'
        )
      }
      if (!createCurvyPlugin) {
        throw new Error(
          `createCurvyPlugin not found on module. Keys: ${Object.keys(mod).join(', ') || '(none)'}`
        )
      }

      const chainId = params.chainId ?? 11155111n
      const host = await hostFactory(
        this.#keystore,
        this.#networks,
        this.#selectedAccount,
        chainId,
      )

      const account = this.#selectedAccount.account
      if (!account) throw new Error('No account selected')

      // Resolve WASM URL for the Curvy SDK core module.
      // In extension context, chrome.runtime.getURL points to the file
      // copied into the build output by webpack (CopyPlugin).
      const chromeRef = (globalThis as any).chrome
      const wasmUrl =
        chromeRef?.runtime?.getURL
          ? chromeRef.runtime.getURL('assets/curvy/curvy-core-v1.0.2.wasm')
          : undefined

      this.#plugin = await createCurvyPlugin(host as any, {
        signature: {
          signingAddress: account.addr as `0x${string}`,
          signatureParams: {} as any,
          signatureResult: '0x' as any
        },
        curvyId: params.curvyId as any,
        environment: params.environment ?? 'testnet',
        apiBaseUrl: params.apiBaseUrl,
        wasmUrl
      })

      this.curvyId = (await this.#plugin.instanceId()) as string
      this.status = 'ready'
      this.lastResult = { curvyId: this.curvyId }
    } catch (e: any) {
      // Log full error with stack to service worker console for debugging
      // eslint-disable-next-line no-console
      console.error('[CurvyController] init failed:', e)
      this.status = 'error'
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.#initializing = false
    this.emitUpdate()
  }

  async fetchBalance(): Promise<void> {
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      const result = await this.#plugin.balance(undefined)
      this.balance = result as any[]
      this.lastResult = result
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  async prepareShield(asset: any): Promise<void> {
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      const result = await this.#plugin.prepareShield(asset)
      this.lastResult = result
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  async transfer(asset: any, toCurvyId: string): Promise<void> {
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      const op = await this.#plugin.prepareTransfer(asset, toCurvyId as any)
      await this.#plugin.broadcast(op)
      this.lastResult = { success: true, toCurvyId }
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  async unshield(asset: any, toAddress: string): Promise<void> {
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      const op = await this.#plugin.prepareUnshield(asset, toAddress as `0x${string}`)
      await this.#plugin.broadcast(op)
      this.lastResult = { success: true, toAddress }
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  destroy(): void {
    this.#plugin = null
    this.curvyId = null
    this.balance = []
    this.status = 'idle'
    this.error = null
    this.lastResult = null
    this.emitUpdate()
  }
}
