import { Icon, type IconName } from './Icon'

export type NavView = 'chat' | 'control' | 'files' | 'store' | 'automations' | 'settings'

const LINKS: Array<{ path: NavView; icon: IconName; title: string }> = [
  { path: 'chat', icon: 'chat_bubble', title: 'Chat' },
  { path: 'control', icon: 'account_tree', title: 'Control Room' },
  { path: 'files', icon: 'difference', title: 'Files' },
  { path: 'store', icon: 'store', title: 'Store' },
  { path: 'automations', icon: 'history', title: 'Automations' },
  { path: 'settings', icon: 'tune', title: 'Settings' },
]

/**
 * Six destinations, each rendering something real — that is the whole
 * contract this rail enforces. Approvals live inside the chat (and ring the
 * tab title), so they are deliberately not a destination.
 */
export function Nav({ view, onViewChange, approvalWaiting, reachable = false }: { view: NavView; onViewChange: (view: NavView) => void; approvalWaiting: boolean; reachable?: boolean }) {
  return (
    <nav aria-label="Primary" className="fixed left-0 top-14 bottom-0 w-16 bg-surface-container-lowest z-30 flex flex-col items-center py-4 border-r border-outline-variant/20">
      <ul className="flex-1 flex flex-col gap-2 w-full px-2">
        {LINKS.map((link) => (
          <li key={link.path}>
            <button
              type="button"
              title={link.title}
              aria-label={link.title}
              aria-current={view === link.path ? 'page' : undefined}
              className={`relative h-10 w-full rounded-lg flex items-center justify-center transition-colors ${view === link.path ? 'bg-surface-container text-on-surface' : 'text-on-surface-variant hover:bg-surface-container/60 hover:text-on-surface'}`}
              onClick={() => onViewChange(link.path)}
            >
              {view === link.path ? <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-[1px] bg-primary" aria-hidden="true" /> : null}
              <Icon name={link.icon} className="text-[22px]" />
              {link.path === 'chat' && approvalWaiting ? (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-secondary" title="A decision is waiting" />
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-center gap-2" aria-hidden="true">
        <span className={`w-2 h-2 rounded-full ${reachable ? 'bg-secondary' : 'bg-outline'}`} title={reachable ? 'Bridge reachable at last check' : 'Bridge status unavailable'} />
      </div>
    </nav>
  )
}
