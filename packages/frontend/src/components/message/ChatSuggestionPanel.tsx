import React from 'react'
import classNames from 'classnames'

import type { ChatSuggestionState } from '../../hooks/chat/useChatSuggestion'
import styles from './ChatSuggestionPanel.module.scss'
import {
  suggestionPanelActionLabels,
  shouldRenderSuggestionPanel,
  suggestionPanelBodyText,
  suggestionPanelStatusText,
} from './chatSuggestionPanelState'

type Props = {
  state: ChatSuggestionState
  onCopy: () => void
  onRegenerate: () => void
  onDismiss: () => void
  autoEnabled: boolean
  onToggleAuto: (nextValue: boolean) => void
  autoManagedStatusText?: string | null
}

export default function ChatSuggestionPanel({
  state,
  onCopy,
  onRegenerate,
  onDismiss,
  autoEnabled,
  onToggleAuto,
  autoManagedStatusText,
}: Props) {
  if (!shouldRenderSuggestionPanel(state)) {
    return null
  }

  const copyDisabled = !state.suggestedReply
  const [copyLabel, regenerateLabel, dismissLabel] = suggestionPanelActionLabels()

  return (
    <section className={styles.panel} aria-live='polite'>
      <div className={styles.headerRow}>
        <div className={styles.title}>Reply suggestion</div>
        <span
          className={classNames(styles.statusBadge, {
            [styles.ready]: state.status === 'ready',
            [styles.generating]:
              state.status === 'generating' || state.status === 'queued',
            [styles.error]: state.status === 'error',
            [styles.stale]: state.status === 'stale',
          })}
        >
          {suggestionPanelStatusText(state)}
        </span>
      </div>
      {autoManagedStatusText && (
        <div className={styles.autoManagedStatus}>{autoManagedStatusText}</div>
      )}

      <pre className={styles.body}>{suggestionPanelBodyText(state)}</pre>

      <div className={styles.actions}>
        <button type='button' onClick={onCopy} disabled={copyDisabled}>
          {copyLabel}
        </button>
        <button type='button' onClick={onRegenerate}>
          {regenerateLabel}
        </button>
        <button type='button' onClick={onDismiss}>
          {dismissLabel}
        </button>
        <button
          type='button'
          role='switch'
          aria-checked={autoEnabled}
          className={styles.autoSwitch}
          onClick={() => onToggleAuto(!autoEnabled)}
        >
          <span className={styles.autoSwitchState}>
            {autoEnabled ? 'Auto On' : 'Auto Off'}
          </span>
          <span className={styles.autoSwitchTrack}>
            <span className={styles.autoSwitchThumb} />
          </span>
        </button>
      </div>
    </section>
  )
}
