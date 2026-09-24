import {
  AlertCircle, ArrowUp, BadgeCheck, Bot, Brain, Bug, Check, ChevronDown, ClipboardCheck,
  ClipboardList, Compass, DraftingCompass, FileDiff, FolderOpen, Gavel, HelpCircle,
  History, KeyRound, Lock, MessageCircle, Moon, Network, Pause, Pencil, Play,
  ShieldCheck, SlidersHorizontal, Square, Store, Sun, Terminal, Trash2, TrendingUp,
  User, Users, Workflow, Wrench, X, Ban,
} from 'lucide-react'

// Only the shipped glyphs are bundled. The former variable icon font cost 4 MB.
const icons = {
  hub: Network, folder_open: FolderOpen, expand_more: ChevronDown, check: Check,
  key_off: KeyRound, pause: Pause, play_arrow: Play, stop: Square, light_mode: Sun,
  dark_mode: Moon, tune: SlidersHorizontal, chat_bubble: MessageCircle,
  account_tree: Workflow, difference: FileDiff, store: Store, history: History,
  error: AlertCircle, close: X, smart_toy: Bot, help: HelpCircle, gavel: Gavel,
  verified: BadgeCheck, checklist: ClipboardList, arrow_upward: ArrowUp,
  person: User, psychology: Brain, travel_explore: Compass, construction: Wrench,
  architecture: DraftingCompass, edit: Pencil, bug_report: Bug,
  content_paste_search: ClipboardCheck, badge: Users, security: ShieldCheck,
  monitoring: TrendingUp, settings: SlidersHorizontal, terminal: Terminal,
  delete: Trash2, lock: Lock, lan: Network, block: Ban,
} as const

export type IconName = keyof typeof icons

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const Glyph = icons[name]
  return <Glyph aria-hidden="true" focusable="false" width="1em" height="1em" strokeWidth={1.8} className={`inline-block shrink-0 align-middle ${className}`} />
}
