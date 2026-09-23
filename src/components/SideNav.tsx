export type NavView = 'chat' | 'control' | 'artifacts' | 'automations' | 'settings'

export function Sidebar({ view, onViewChange }: { view: NavView; onViewChange: (v: NavView) => void }) {
  // Only destinations that render something. Approvals live inside the chat
  // (and ring the tab title) — a nav item that shows the chat view is a lie.
  const links: Array<{ path: NavView; icon: string; title: string }> = [
    { path: 'chat', icon: 'chat_bubble', title: 'Chat' },
    { path: 'control', icon: 'account_tree', title: 'Control Room' },
    { path: 'artifacts', icon: 'deployed_code', title: 'Artifacts' },
    { path: 'automations', icon: 'history', title: 'Automations' },
    { path: 'settings', icon: 'tune', title: 'Settings' },
  ]
  return (
    <aside className="fixed left-0 top-14 bottom-0 w-16 bg-surface-dim z-30 flex flex-col items-center py-4 border-r border-outline-variant/20">
      <nav className="flex-1 flex flex-col gap-2 w-full px-2">
        {links.map((link) => (
          <a
            key={link.path}
            href="#"
            title={link.title}
            aria-current={view === link.path ? 'page' : undefined}
            className={`h-10 w-full rounded flex items-center justify-center transition-colors ${
              view === link.path
                ? 'bg-primary-container text-on-primary-container glow-primary'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            }`}
            onClick={(e) => { e.preventDefault(); onViewChange(link.path) }}
          >
            <span className="material-symbols-outlined text-xl">{link.icon}</span>
          </a>
        ))}
      </nav>
      <div className="flex flex-col items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-tertiary" title="Daemon connected" />
      </div>
    </aside>
  )
}
