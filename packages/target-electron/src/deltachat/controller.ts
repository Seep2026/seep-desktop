import { app as rawApp, ipcMain } from 'electron'
import { yerpc, BaseDeltaChat, type DcEvent } from '@deltachat/jsonrpc-client'
import { getRPCServerPath } from '@deltachat/stdio-rpc-server'

import { getLogger } from '../../../shared/logger.js'
import * as mainWindow from '../windows/main.js'
import { ExtendedAppMainProcess } from '../types.js'
import DCWebxdc from './webxdc.js'
import { DesktopSettings } from '../desktop_settings.js'
import { StdioServer } from './stdio_server.js'
import rc_config from '../rc.js'
import {
  migrateAccountsIfNeeded,
  disableDeleteFromServerConfig,
} from './migration.js'

const app = rawApp as ExtendedAppMainProcess
const log = getLogger('main/deltachat')
const logCoreEvent = getLogger('core/event')

class ElectronMainTransport extends yerpc.BaseTransport {
  constructor(private sender: (message: yerpc.Message) => void) {
    super()
  }

  onMessage(message: yerpc.Message): void {
    this._onmessage(message)
  }

  _send(message: yerpc.Message): void {
    this.sender(message)
  }
}

export class JRPCDeltaChat extends BaseDeltaChat<ElectronMainTransport> {}

/**
 * DeltaChatController
 *
 * - proxy for a deltachat instance
 * - sends events to renderer
 * - handles events from renderer
 */
export default class DeltaChatController {
  /**
   * Created and owned by ipc on the backend
   */

  _inner_account_manager: StdioServer | null = null
  get account_manager(): Readonly<StdioServer> {
    if (!this._inner_account_manager) {
      throw new Error('account manager is not defined (yet?)')
    }
    return this._inner_account_manager
  }
  /** for runtime info */
  rpcServerPath?: string

  constructor(public cwd: string) {}

  _jsonrpcRemote: JRPCDeltaChat | null = null
  get jsonrpcRemote(): Readonly<JRPCDeltaChat> {
    if (!this._jsonrpcRemote) {
      throw new Error('_jsonrpcRemote is not defined (yet?)')
    }
    return this._jsonrpcRemote
  }

  private mainEventPumpTask: Promise<void> | null = null
  private stopMainEventPump = false

  private readonly onCoreEvent = (contextId: number, event: DcEvent) => {
    mainWindow.send('json-rpc-core-event', { contextId, event })
    const message =
      typeof (event as { msg?: unknown }).msg === 'string'
        ? (event as { msg: string }).msg
        : ''
    if (event.kind === 'WebxdcRealtimeData') {
      return
    }
    if (event.kind === 'Warning') {
      logCoreEvent.warn(contextId, message)
    } else if (event.kind === 'Info') {
      logCoreEvent.info(contextId, message)
    } else if (event.kind.startsWith('Error')) {
      logCoreEvent.error(contextId, message)
    } else if (app.rc['log-debug']) {
      logCoreEvent.debug(contextId, event.kind, event)
    }
  }

  private dispatchCoreEvent(contextId: number, event: DcEvent) {
    const jsonrpcRemote_ = this._jsonrpcRemote
    if (!jsonrpcRemote_) {
      return
    }
    type JRPCDeltaChatWithPrivateExposed = {
      [P in keyof typeof jsonrpcRemote_]: (typeof jsonrpcRemote_)[P]
    } & {
      contextEmitters: (typeof jsonrpcRemote_)['contextEmitters']
    }
    const jsonrpcRemote =
      jsonrpcRemote_ as unknown as JRPCDeltaChatWithPrivateExposed

    try {
      ;(
        jsonrpcRemote.emit as unknown as (
          this: unknown,
          eventName: string,
          contextId: number,
          payload: unknown
        ) => void
      ).call(jsonrpcRemote, event.kind, contextId, event)
    } catch (error) {
      log.error('core-event-listener-error', { contextId, kind: event.kind, error })
    }

    try {
      ;(
        jsonrpcRemote.emit as unknown as (
          this: unknown,
          eventName: string,
          contextId: number,
          payload: unknown
        ) => void
      ).call(jsonrpcRemote, 'ALL', contextId, event)
    } catch (error) {
      log.error('core-event-listener-error', {
        contextId,
        kind: 'ALL',
        eventKind: event.kind,
        error,
      })
    }

    const contextEmitter = jsonrpcRemote.contextEmitters[contextId]
    if (contextEmitter) {
      try {
        contextEmitter.emit(event.kind, event as any)
      } catch (error) {
        log.error('core-context-listener-error', {
          contextId,
          kind: event.kind,
          error,
        })
      }
      try {
        contextEmitter.emit('ALL', event as any)
      } catch (error) {
        log.error('core-context-listener-error', {
          contextId,
          kind: 'ALL',
          eventKind: event.kind,
          error,
        })
      }
    }

    try {
      this.onCoreEvent(contextId, event)
    } catch (error) {
      log.error('core-event-forward-error', { contextId, kind: event.kind, error })
    }
  }

  private startMainEventPump() {
    if (this.mainEventPumpTask) {
      return
    }
    this.stopMainEventPump = false
    this.mainEventPumpTask = (async () => {
      while (!this.stopMainEventPump) {
        try {
          const nextEvent = await this.jsonrpcRemote.rpc.getNextEvent()
          this.dispatchCoreEvent(nextEvent.contextId, nextEvent.event as DcEvent)
        } catch (error) {
          log.error('core-event-pump-error', error)
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
    })()
  }

  async init() {
    log.debug('Check if legacy accounts need migration')
    if (await migrateAccountsIfNeeded(this.cwd, getLogger('migration'))) {
      // Clear some settings that we can't migrate
      DesktopSettings.update({
        lastAccount: undefined,
        lastChats: {},
        lastSaveDialogLocation: undefined,
      })
    }

    log.debug('Initiating DeltaChatNode')
    let serverPath = await getRPCServerPath({
      // desktop should only use prebuilds normally
      disableEnvPath: !rc_config['allow-unsafe-core-replacement'],
    })
    if (serverPath.includes('app.asar')) {
      // probably inside of electron build
      serverPath = serverPath.replace('app.asar', 'app.asar.unpacked')
    }

    this.rpcServerPath = serverPath
    log.info('using deltachat-rpc-server at', { serverPath })

    let mainProcessTransport: ElectronMainTransport | null = null
    this._inner_account_manager = new StdioServer(
      response => {
        try {
          // The `main-` in the ID prefix signifies that this is a response
          // to a request that originated from this (main) process's
          // JSON-RPC client, and not the JSON-RPC client
          // of the renderer process.
          // Thus we don't need to forward this response
          // to the renderer process.
          if (response.indexOf('"id":"main-') !== -1) {
            const message = JSON.parse(response)
            if (message.id.startsWith('main-')) {
              message.id = Number(message.id.replace('main-', ''))
              mainProcessTransport?.onMessage(message)
              return
            }
          }
        } catch (error) {
          log.error('jsonrpc-decode', error)
        }
        mainWindow.send('json-rpc-message', response)
      },
      this.cwd,
      serverPath
    )

    mainProcessTransport = new ElectronMainTransport(message => {
      message.id = `main-${message.id}`
      this.account_manager.send(JSON.stringify(message))
    })

    ipcMain.handle('json-rpc-request', (_ev, message) => {
      this.account_manager.send(message)
    })

    this.account_manager.start()
    log.info('HI')

    this._jsonrpcRemote = new JRPCDeltaChat(
      mainProcessTransport,
      // Main process is the only consumer of `get_next_event`.
      false
    )
    this.startMainEventPump()

    await disableDeleteFromServerConfig(
      this.jsonrpcRemote.rpc,
      getLogger('migration')
    )

    if (DesktopSettings.state.syncAllAccounts) {
      log.info('Ready, starting accounts io...')
      this.jsonrpcRemote.rpc.startIoForAllAccounts()
      log.info('Started accounts io.')
    }
  }

  readonly webxdc = new DCWebxdc(this)
}
