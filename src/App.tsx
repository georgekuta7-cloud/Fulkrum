import { useEffect } from 'react'

/**
 * The interface was erased on purpose: three redesigns had stacked into dead
 * code, orphaned features, and a test suite certifying components that no
 * longer shipped. What remains is the data layer (useBridge, api client,
 * runGraph), the design tokens, and this honest stub. The rebuild starts from
 * here, against the approved spec, with nothing carried over unexamined.
 */
export default function App() {
  useEffect(() => {
    document.documentElement.classList.toggle('dark', localStorage.getItem('fulkrum.theme') !== 'light')
  }, [])

  return (
    <div className="min-h-screen bg-surface text-on-surface antialiased flex items-center justify-center">
      <div className="text-center space-y-3">
        <span className="material-symbols-outlined text-5xl text-primary">hub</span>
        <h1 className="text-headline-lg font-semibold tracking-tight">Fulkrum</h1>
        <p className="text-body-md text-on-surface-variant">The interface is being rebuilt. The bridge is running on 127.0.0.1:8787 — the API and data are intact.</p>
      </div>
    </div>
  )
}
