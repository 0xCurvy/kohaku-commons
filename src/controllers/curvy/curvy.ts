import EventEmitter from '../eventEmitter/eventEmitter'
import type { KeystoreController } from '../keystore/keystore'
import type { NetworksController } from '../networks/networks'
import type { SelectedAccountController } from '../selectedAccount/selectedAccount'
import type { AccountsController } from '../accounts/accounts'
import type { ProvidersController } from '../providers/providers'
import type { PortfolioController } from '../portfolio/portfolio'
import type { ActivityController } from '../activity/activity'
import type { ExternalSignerControllers } from '../../interfaces/keystore'
import { SignAccountOpController } from '../signAccountOp/signAccountOp'
import { StorageController } from '../storage/storage'
import { AccountOp } from '../../libs/accountOp/accountOp'
import { Call } from '../../libs/accountOp/types'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { getAmbirePaymasterService } from '../../libs/erc7677/erc7677'
import { randomId } from '../../libs/humanizer/utils'
import { EstimationStatus } from '../estimation/types'
import wait from '../../utils/wait'
import { hostFactory } from '../privacyPools/hostFactory'

export type CurvyStatus = 'idle' | 'initializing' | 'ready' | 'error'

export class CurvyController extends EventEmitter {
  #keystore: KeystoreController

  #networks: NetworksController

  #selectedAccount: SelectedAccountController

  #accounts: AccountsController

  #providers: ProvidersController

  #portfolio: PortfolioController

  #activity: ActivityController

  #externalSignerControllers: ExternalSignerControllers

  #storage: StorageController

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #plugin: any = null

  #initializing = false

  #signAccountOpSubscriptions: Function[] = []

  #reestimateAbortController: AbortController | null = null

  curvyId: string | null = null

  balance: any[] = []

  status: CurvyStatus = 'idle'

  error: string | null = null

  lastResult: any = null

  signAccountOpController: SignAccountOpController | null = null

  hasProceeded: boolean = false

  latestBroadcastedAccountOp: AccountOp | null = null

  shouldTrackLatestBroadcastedAccountOp: boolean = true

  constructor(
    keystore: KeystoreController,
    networks: NetworksController,
    selectedAccount: SelectedAccountController,
    accounts: AccountsController,
    providers: ProvidersController,
    portfolio: PortfolioController,
    activity: ActivityController,
    externalSignerControllers: ExternalSignerControllers,
    storage: StorageController
  ) {
    super()
    this.#keystore = keystore
    this.#networks = networks
    this.#selectedAccount = selectedAccount
    this.#accounts = accounts
    this.#providers = providers
    this.#portfolio = portfolio
    this.#activity = activity
    this.#externalSignerControllers = externalSignerControllers
    this.#storage = storage
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

      // Load persisted curvyId for this account, or use the one from params,
      // or generate a new one for first-time registration.
      const storageKey = `curvy:id:${account.addr}`
      const storedCurvyId = await this.#storage.get(storageKey, null as string | null)
      const curvyId =
        params.curvyId ?? storedCurvyId ?? `kh-${randomId().toString(36).slice(0, 16)}`

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
        curvyId: curvyId as any,
        environment: (params.environment === 'testnet' ? 'testnet' : undefined),
        apiBaseUrl: params.apiBaseUrl,
        wasmUrl
      })

      this.curvyId = (await this.#plugin.instanceId()) as string
      await this.#storage.set(storageKey, this.curvyId)
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
    // eslint-disable-next-line no-console
    console.log('[CurvyController] fetchBalance called, hasPlugin:', !!this.#plugin, 'status:', this.status)
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      const result = await this.#plugin.balance(undefined)
      // eslint-disable-next-line no-console
      console.log('[CurvyController] fetchBalance result:', JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v))
      this.balance = result as any[]
      this.lastResult = result
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[CurvyController] fetchBalance error:', e)
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  async prepareShield(asset: any): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[CurvyController] prepareShield called', { asset, hasPlugin: !!this.#plugin, status: this.status })
    if (!this.#plugin) {
      this.error = 'Plugin not initialized'
      this.emitUpdate()
      return
    }

    try {
      this.error = null
      // eslint-disable-next-line no-console
      console.log('[CurvyController] calling plugin.prepareShield...')
      const result = await this.#plugin.prepareShield(asset)
      // eslint-disable-next-line no-console
      console.log('[CurvyController] plugin.prepareShield result:', result)
      this.lastResult = result

      // Convert ShieldTx[] → AccountOp calls and feed into signing pipeline
      const txs: Array<{ to: string; data: string; value: bigint }> = result?.txs ?? []
      // eslint-disable-next-line no-console
      console.log('[CurvyController] prepareShield txs:', txs.length, txs)
      if (txs.length > 0) {
        const calls: Call[] = txs.map((tx) => ({
          to: tx.to as `0x${string}`,
          data: tx.data as `0x${string}`,
          value: BigInt(tx.value ?? 0)
        }))
        await this.syncSignAccountOp(calls)
      } else {
        // eslint-disable-next-line no-console
        console.warn('[CurvyController] prepareShield returned 0 txs – signAccountOpController will NOT be created')
        this.error = 'Shield preparation returned no transactions. Please try again.'
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[CurvyController] prepareShield error:', e)
      this.error = e?.message ?? String(e)
      this.lastResult = { error: this.error }
    }

    this.emitUpdate()
  }

  async syncSignAccountOp(calls: Call[]): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[CurvyController] syncSignAccountOp', { callsCount: calls.length, hasAccount: !!this.#selectedAccount?.account })
    if (!this.#selectedAccount?.account) return
    if (!calls.length) return

    try {
      this.shouldTrackLatestBroadcastedAccountOp = true

      if (this.signAccountOpController) {
        this.destroySignAccountOp()
      }

      this.hasProceeded = false

      await this.#initSignAccOp(calls)
      // eslint-disable-next-line no-console
      console.log('[CurvyController] syncSignAccountOp complete, signAccountOpController:', !!this.signAccountOpController)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[CurvyController] syncSignAccountOp error:', error)
      this.emitError({
        level: 'major',
        message: 'Failed to initialize transaction signing',
        error: error instanceof Error ? error : new Error('Unknown error in syncSignAccountOp')
      })
    }
  }

  async #initSignAccOp(calls: Call[]): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[CurvyController] #initSignAccOp', { hasAccount: !!this.#selectedAccount?.account, alreadyHasController: !!this.signAccountOpController })
    if (!this.#selectedAccount?.account || this.signAccountOpController || !this.#accounts) return

    const chainId = 11155111n
    const network = this.#networks.networks.find((net) => net.chainId === chainId)
    // eslint-disable-next-line no-console
    console.log('[CurvyController] #initSignAccOp network:', network?.name, network?.chainId?.toString())
    if (!network) return

    const provider = this.#providers.providers[network.chainId.toString()]
    const accountState = await this.#accounts.getOrFetchAccountOnChainState(
      this.#selectedAccount.account.addr,
      network.chainId
    )

    if (!this.#keystore) return

    const baseAcc = getBaseAccount(
      this.#selectedAccount.account,
      accountState,
      this.#keystore.getAccountKeys(this.#selectedAccount.account),
      network
    )

    const accountOp: AccountOp = {
      accountAddr: this.#selectedAccount.account.addr,
      chainId: network.chainId,
      signingKeyAddr: null,
      signingKeyType: null,
      gasLimit: null,
      gasFeePayment: null,
      nonce: accountState.nonce,
      signature: null,
      accountOpToExecuteBefore: null,
      calls,
      meta: {
        paymasterService: getAmbirePaymasterService(baseAcc, '')
      }
    }

    this.signAccountOpController = new SignAccountOpController(
      this.#accounts,
      this.#networks,
      this.#keystore,
      this.#portfolio,
      this.#activity,
      this.#externalSignerControllers,
      this.#selectedAccount.account,
      network,
      provider,
      randomId(),
      accountOp,
      () => true,
      false,
      undefined
    )

    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onUpdate(() => {
        this.emitUpdate()
      })
    )
    this.#signAccountOpSubscriptions.push(
      this.signAccountOpController.onError((error) => {
        if (this.signAccountOpController)
          this.#portfolio.overridePendingResults(this.signAccountOpController.accountOp)
        this.emitError(error)
      })
    )

    if (this.signAccountOpController) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.signAccountOpController.estimate()
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.#reestimate()
  }

  async #reestimate(): Promise<void> {
    if (!this.signAccountOpController || this.#reestimateAbortController) return

    this.#reestimateAbortController = new AbortController()
    const signal = this.#reestimateAbortController!.signal

    const loop = async () => {
      // eslint-disable-next-line no-await-in-loop
      await wait(30000)

      while (!signal.aborted) {
        if (signal.aborted) break

        if (this.signAccountOpController?.estimation.status !== EstimationStatus.Loading) {
          // eslint-disable-next-line no-await-in-loop
          await this.signAccountOpController?.estimate()
        }

        // eslint-disable-next-line no-await-in-loop
        await wait(30000)
      }
    }

    loop().catch(() => {})
  }

  destroySignAccountOp(): void {
    this.#reestimateAbortController?.abort()
    this.#reestimateAbortController = null

    this.#signAccountOpSubscriptions.forEach((unsub) => unsub())
    this.#signAccountOpSubscriptions = []

    if (this.signAccountOpController) {
      this.signAccountOpController.reset()
      this.signAccountOpController = null
    }

    this.hasProceeded = false
    this.emitUpdate()
  }

  destroyLatestBroadcastedAccountOp(): void {
    this.shouldTrackLatestBroadcastedAccountOp = false
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }

  setUserProceeded(hasProceeded: boolean): void {
    this.hasProceeded = hasProceeded
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
    this.destroySignAccountOp()
    this.#plugin = null
    this.curvyId = null
    this.balance = []
    this.status = 'idle'
    this.error = null
    this.lastResult = null
    this.latestBroadcastedAccountOp = null
    this.emitUpdate()
  }
}
