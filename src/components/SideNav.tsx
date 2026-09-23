export type NavView = 'chat' | 'artifacts' | 'approvals' | 'settings'

export function Sidebar({ view, onViewChange }: { view: NavView; onViewChange: (v: NavView) => void }) {
  const links: Array<{ path: NavView; icon: string; title: string }> = [
    { path: 'chat', icon: 'chat_bubble', title: 'Chat' },
    { path: 'artifacts', icon: 'deployed_code', title: 'Artifacts' },
    { path: 'approvals', icon: 'verified', title: 'Approvals' },
    { path: 'settings', icon: 'settings', title: 'Settings' },
  ]
  return (
    <aside className="m3-sidebar">
      <nav className="m3-sidebar-nav">
        {links.map((link) => (
          <a
            key={link.path}
            href="#"
            title={link.title}
            aria-current={view === link.path ? 'page' : undefined}
            className={`m3-sidebar-link ${view === link.path ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); onViewChange(link.path) }}
          >
            <span className="material-symbols-outlined">{link.icon}</span>
          </a>
        ))}
      </nav>
      <div className="m3-sidebar-status">
        <span className="m3-status-dot" title="Daemon connected" />
      </div>
    </aside>
  )
}
