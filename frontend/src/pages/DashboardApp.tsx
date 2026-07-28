import { lazy, Suspense, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { List } from 'react-window'
import {
  LayoutDashboard, ClipboardCheck, KanbanSquare, CalendarDays, Users, ChartColumn,
  Activity as ActivityIcon, Settings as SettingsIcon, Bell, BellRing, LogOut, X, UserPlus, Menu,
  CreditCard, Download, Volume2, Vibrate, CheckCheck, Gauge, Trophy, Maximize2, Search, ChevronLeft, WifiOff, RefreshCw,
  User as UserIcon, Upload, Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authFetch, getStoredToken, jsonHeaders, SessionExpiredError } from '../lib/api'
import { getNotificationPermission, isPushSupported, onServiceWorkerMessage, sendTestPush, subscribeToPush, unsubscribeFromPush, type ServiceWorkerMessage } from '../lib/push'
import { REMINDER_OFFSETS } from '../lib/reminders'
import { DEFAULT_RECURRENCE, type RecurrenceConfig } from '../lib/recurrence'
import { cacheTasks, getCachedTasks, getOutboxCount, isOnline, queueMutation, syncOutbox, upsertCachedTask } from '../lib/offline'
import { StatSummaryCards } from '../components/StatSummaryCards'
import type { StatusCounts, TrendPoint } from '../components/TaskCharts'
import Modal from '../components/Modal'
import TaskDetailPanel from '../components/TaskDetailPanel'
import RecurrencePicker from '../components/RecurrencePicker'
import QuickCapture from '../components/QuickCapture'
import FocusMode, { type FocusTask } from '../components/FocusMode'
import SmartDashboardHeader from '../components/SmartDashboardHeader'
import AchievementsPanel from '../components/AchievementsPanel'
import InstallPrompt from '../components/InstallPrompt'
import NotificationCard, { type NotifItem } from '../components/NotificationCard'
import EmptyState from '../components/EmptyState'
import OnboardingWizard from '../components/OnboardingWizard'
import { TaskListRow, TaskListRowStatic } from '../components/TaskListRow'
import { SkeletonChart, SkeletonList, SkeletonStatCards } from '../components/Skeleton'

// FullCalendar (TaskCalendar) and the billing/checkout UI are each sizeable
// and only needed on their own tab — code-split out of the main
// DashboardApp chunk (itself already lazy-loaded from App.tsx) so visiting
// Tasks/Boards/Dashboard doesn't pay for either.
const TaskCalendar = lazy(() => import('../components/TaskCalendar'))
const BillingPanel = lazy(() => import('../components/BillingPanel'))

// recharts alone is ~356KB — the single largest dependency in the app — and
// was previously loaded eagerly just by DashboardApp importing TaskCharts
// and InsightsPanel/WorkloadCharts, meaning it blocked the very first
// screen after login (the Dashboard tab renders two of these charts
// immediately). Splitting each chart out as its own lazy() still resolves
// to one shared TaskCharts chunk (Vite dedupes repeated dynamic imports of
// the same module), loaded once, only when a page that actually renders a
// chart is visited.
const StatusDoughnutChart = lazy(() => import('../components/TaskCharts').then(m => ({ default: m.StatusDoughnutChart })))
const StatusBarChart = lazy(() => import('../components/TaskCharts').then(m => ({ default: m.StatusBarChart })))
const CompletionTrendChart = lazy(() => import('../components/TaskCharts').then(m => ({ default: m.CompletionTrendChart })))
const WorkloadCharts = lazy(() => import('../components/WorkloadCharts'))
const InsightsPanel = lazy(() => import('../components/InsightsPanel'))
import '../App.css'

type NavPage = 'dashboard' | 'tasks' | 'boards' | 'calendar' | 'team' | 'reports' | 'activity' | 'notifications' | 'settings' | 'billing' | 'workload'

type NotificationPreferences = { pushEnabled: boolean; soundEnabled: boolean; vibrationEnabled: boolean; defaultReminderMinutes: number[] }
type Toast = { id: string; title: string; body: string; taskId?: string | null }
type WorkspacePlan = {
  canUseKanban: boolean; canUseCalendar: boolean; canUseSubtasks: boolean; canUseRecurringTasks: boolean
  canUseDependencies: boolean; canUseLabels: boolean; canUseAnalytics: boolean; canUseFileAttachments: boolean; canUseExport: boolean
}
const DEFAULT_PLAN: WorkspacePlan = { canUseKanban: false, canUseCalendar: false, canUseSubtasks: false, canUseRecurringTasks: false, canUseDependencies: false, canUseLabels: false, canUseAnalytics: false, canUseFileAttachments: false, canUseExport: false }

type Workspace = { id: string; name: string; description?: string | null }
type DepRef = { id: string; title: string; status: string }
export type Task = {
  id: string; title: string; description?: string | null; status: string; priority: string; workspaceId: string
  dueDate?: string | null; assignedToId?: string | null; completedAt?: string | null; updatedAt?: string
  dependsOn?: DepRef[]; blocks?: DepRef[]; subtasks?: DepRef[]; estimatedMinutes?: number | null
  isRecurring?: boolean; recurrenceRule?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null
  recurrenceInterval?: number | null; recurrenceDaysOfWeek?: number[]; recurrenceBusinessDaysOnly?: boolean
  recurrenceEndDate?: string | null; recurrenceCount?: number | null
}
type Invitation = { id: string; email: string; workspaceId: string; token: string; status: string; expiresAt: string; role?: string; workspace?: { id: string; name: string } }
type Member = { id: string; userId: string; role: string; user: { id: string; firstname: string; lastName: string; email: string; avatarUrl?: string | null } }
type Session = { id: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string; lastUsedAt: string; expiresAt: string; isCurrent: boolean }
type ActivityEntry = { id: string; action: string; createdAt: string; user?: { firstname: string; lastName: string } | null; workspace?: { name: string } | null; task?: { title: string } | null }

const taskToRecurrence = (tk?: Task | null): RecurrenceConfig => tk ? {
  isRecurring: !!tk.isRecurring,
  recurrenceRule: tk.recurrenceRule || 'WEEKLY',
  recurrenceInterval: tk.recurrenceInterval || 1,
  recurrenceDaysOfWeek: tk.recurrenceDaysOfWeek || [],
  recurrenceBusinessDaysOnly: !!tk.recurrenceBusinessDaysOnly,
  recurrenceEndDate: tk.recurrenceEndDate ? tk.recurrenceEndDate.slice(0, 10) : '',
  recurrenceCount: tk.recurrenceCount || '',
} : DEFAULT_RECURRENCE

const statusColumns = ['TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETED']
// Below this count, mapping the list directly is simpler and just as fast;
// past it, rendering every row's DOM at once becomes the bottleneck.
const VIRTUALIZE_THRESHOLD = 40
const navItems: { page: NavPage; label: string; icon: LucideIcon }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { page: 'tasks', label: 'My Tasks', icon: ClipboardCheck },
  { page: 'boards', label: 'Boards', icon: KanbanSquare },
  { page: 'calendar', label: 'Calendar', icon: CalendarDays },
  { page: 'workload', label: 'Workload', icon: Gauge },
  { page: 'team', label: 'Team', icon: Users },
  { page: 'reports', label: 'Reports', icon: ChartColumn },
  { page: 'activity', label: 'Activity', icon: ActivityIcon },
  { page: 'notifications', label: 'Notifications', icon: BellRing },
  { page: 'billing', label: 'Billing', icon: CreditCard },
  { page: 'settings', label: 'Settings', icon: SettingsIcon },
]

const LANGUAGES: Record<string, string> = {
  en: 'English', sw: 'Kiswahili', fr: 'Français', ko: '한국어', es: 'Español', zh: '中文', lg: 'Luganda'
}
type TranslationMap = Record<string, Record<string, string>>
const translations: TranslationMap = {
  dashboard: { en: 'Dashboard', sw: 'Dashibodi', fr: 'Tableau de bord', ko: '대시보드', es: 'Panel', zh: '仪表盘', lg: 'Ddaabadi' },
  myTasks: { en: 'My Tasks', sw: 'Kazi Zangu', fr: 'Mes Tâches', ko: '내 작업', es: 'Mis Tareas', zh: '我的任务', lg: 'Emirimu Gyange' },
  boards: { en: 'Boards', sw: 'Mbao', fr: 'Tableaux', ko: '보드', es: 'Tableros', zh: '看板', lg: 'Mbaao' },
  calendar: { en: 'Calendar', sw: 'Kalenda', fr: 'Calendrier', ko: '달력', es: 'Calendario', zh: '日历', lg: 'Kalenda' },
  team: { en: 'Team', sw: 'Timu', fr: 'Équipe', ko: '팀', es: 'Equipo', zh: '团队', lg: 'Ttiimu' },
  reports: { en: 'Reports', sw: 'Ripoti', fr: 'Rapports', ko: '리포트', es: 'Informes', zh: '报告', lg: 'Lipooti' },
  activity: { en: 'Activity', sw: 'Shughuli', fr: 'Activité', ko: '활동', es: 'Actividad', zh: '活动', lg: 'Ebikolwa' },
  settings: { en: 'Settings', sw: 'Mipangilio', fr: 'Paramètres', ko: '설정', es: 'Ajustes', zh: '设置', lg: 'Enteeka' },
  morning: { en: 'Good morning', sw: 'Habari za asubuhi', fr: 'Bonjour', ko: '좋은 아침', es: 'Buenos días', zh: '早上好', lg: 'Wasuze otya' },
  afternoon: { en: 'Good afternoon', sw: 'Habari za mchana', fr: 'Bon après-midi', ko: '좋은 오후', es: 'Buenas tardes', zh: '下午好', lg: 'Osiibye otya' },
  evening: { en: 'Good evening', sw: 'Habari za jioni', fr: 'Bonsoir', ko: '좋은 저녁', es: 'Buenas noches', zh: '晚上好', lg: 'Osiibye otya' },
  taskDescription: { en: 'Description', sw: 'Maelezo', fr: 'Description', ko: '설명', es: 'Descripción', zh: '描述', lg: 'Okunnyonnyola' },
  assignTo: { en: 'Assign to...', sw: 'Kwa...', fr: 'Assigner à...', ko: '할당...', es: 'Asignar a...', zh: '分配给...', lg: 'Gaba eri...' },
  noTasks: { en: 'No tasks', sw: 'Hakuna kazi', fr: 'Aucune tâche', ko: '작업 없음', es: 'Sin tareas', zh: '没有任务', lg: 'Tewali mirimu' },
  overview: { en: 'Overview', sw: 'Muhtasari', fr: 'Aperçu', ko: '개요', es: 'Resumen', zh: '概览', lg: 'Endabirira' },
  total: { en: 'Total', sw: 'Jumla', fr: 'Total', ko: '합계', es: 'Total', zh: '总计', lg: 'Omuwendo' },
  completed: { en: 'Completed', sw: 'Imekamilika', fr: 'Terminé', ko: '완료됨', es: 'Completado', zh: '已完成', lg: 'Okumaliriza' },
  inProgress: { en: 'In progress', sw: 'Inaendelea', fr: 'En cours', ko: '진행 중', es: 'En progreso', zh: '进行中', lg: 'Kiri mu maaso' },
  overdue: { en: 'Overdue', sw: 'Imechelewa', fr: 'En retard', ko: '기한 초과', es: 'Vencido', zh: '已逾期', lg: 'Kiyise' },
  teamMembers: { en: 'Team members', sw: 'Wanatimu', fr: 'Membres', ko: '팀 멤버', es: 'Miembros del equipo', zh: '团队成员', lg: 'Abomu ttiimu' },
  recentTasks: { en: 'Recent tasks', sw: 'Kazi za hivi karibuni', fr: 'Taches recentes', ko: '최근 작업', es: 'Tareas recientes', zh: '最近的任务', lg: 'Emirimu ebya kumpi' },
  deadlines: { en: 'Upcoming deadlines', sw: 'Tarehe zinazokuja', fr: 'Échéances à venir', ko: '다가오는 마감', es: 'Próximos vencimientos', zh: '即将截止', lg: 'Enaku ezijja' },
  profile: { en: 'Profile', sw: 'Wasifu', fr: 'Profil', ko: '프로필', es: 'Perfil', zh: '个人资料', lg: 'Pulofayiro' },
  preferences: { en: 'Preferences', sw: 'Mapendeleo', fr: 'Préférences', ko: '환경 설정', es: 'Preferencias', zh: '偏好设置', lg: 'Okusalawo' },
  language: { en: 'Language', sw: 'Lugha', fr: 'Langue', ko: '언어', es: 'Idioma', zh: '语言', lg: 'Olulimi' },
  fontStyle: { en: 'Font style', sw: 'Mtindo wa herufi', fr: 'Style de police', ko: '글꼴 스타일', es: 'Estilo de fuente', zh: '字体风格', lg: 'Enkola y\'ennukuta' },
  colorTheme: { en: 'Color theme', sw: 'Mandhari ya rangi', fr: 'Thème de couleur', ko: '색상 테마', es: 'Tema de color', zh: '颜色主题', lg: 'Essomero l\'langi' },
  invite: { en: 'Invite member', sw: 'Alika mwanatimu', fr: 'Inviter un membre', ko: '멤버 초대', es: 'Invitar miembro', zh: '邀请成员', lg: 'Yita omu ttiimu' },
  workspaceName: { en: 'Workspace name', sw: 'Jina la eneo la kazi', fr: 'Nom de l\'espace', ko: '워크스페이스 이름', es: 'Nombre del espacio', zh: '工作区名称', lg: 'Erinnya ly\'ekifo ky\'omulimu' },
  sendInvite: { en: 'Send invite', sw: 'Tuma mwaliko', fr: 'Envoyer l\'invitation', ko: '초대 보내기', es: 'Enviar invitación', zh: '发送邀请', lg: 'Tuma obuyito' },
  pendingInvites: { en: 'Pending invitations', sw: 'Mialiko inayosubiri', fr: 'Invitations en attente', ko: '대기 중인 초대', es: 'Invitaciones pendientes', zh: '待处理的邀请', lg: 'Obuyito obulindirira' },
  members: { en: 'Members', sw: 'Wanachama', fr: 'Membres', ko: '멤버', es: 'Miembros', zh: '成员', lg: 'Ab\'omu ttiimu' },
  createWorkspace: { en: 'Create workspace', sw: 'Tengeneza eneo la kazi', fr: 'Créer un espace', ko: '워크스페이스 만들기', es: 'Crear espacio', zh: '创建工作区', lg: 'Tonda ekifo ky\'omulimu' },
  progress: { en: 'Progress', sw: 'Maendeleo', fr: 'Progrès', ko: '진행률', es: 'Progreso', zh: '进度', lg: 'Okukulaakulana' },
  addWorkspace: { en: 'Add workspace', sw: 'Ongeza eneo', fr: 'Ajouter un espace', ko: '추가', es: 'Añadir espacio', zh: '添加', lg: 'Yongera' },
  saveProfile: { en: 'Save profile', sw: 'Hifadhi wasifu', fr: 'Enregistrer le profil', ko: '프로필 저장', es: 'Guardar perfil', zh: '保存资料', lg: 'Kkweka pulofayiro' },
  savePrefs: { en: 'Save preferences', sw: 'Hifadhi mapendeleo', fr: 'Enregistrer les préférences', ko: '환경 설정 저장', es: 'Guardar preferencias', zh: '保存偏好', lg: 'Kkweka okusalawo' },
  markAllRead: { en: 'Mark all read', sw: 'Soma zote', fr: 'Tout marquer lu', ko: '모두 읽음', es: 'Marcar todo leído', zh: '全部标记已读', lg: 'Soma zonna' },
  noNotifs: { en: 'No notifications', sw: 'Hakuna arifa', fr: 'Aucune notification', ko: '알림 없음', es: 'Sin notificaciones', zh: '没有通知', lg: 'Tewali kutegeesa' },
  welcome: { en: 'Welcome back', sw: 'Karibu tena', fr: 'Bon retour', ko: '다시 오신 것을 환영합니다', es: 'Bienvenido de nuevo', zh: '欢迎回来', lg: 'Tunakwaniriza' },
  billing: { en: 'Billing', sw: 'Malipo', fr: 'Facturation', ko: '결제', es: 'Facturación', zh: '账单', lg: 'Sasulo' },
  notifications: { en: 'Notifications', sw: 'Arifa', fr: 'Notifications', ko: '알림', es: 'Notificaciones', zh: '通知', lg: 'Okutegeeza' },
  workload: { en: 'Workload', sw: 'Mzigo wa kazi', fr: 'Charge de travail', ko: '업무량', es: 'Carga de trabajo', zh: '工作量', lg: 'Omugugu' },
}

function t(key: string, lang: string): string {
  return translations[key]?.[lang] || translations[key]?.['en'] || key
}
const greeting = (lang: string): string => {
  const hour = new Date().getHours()
  const key = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return t(key, lang)
}
// Shows the user's uploaded photo when they have one; otherwise a plain
// neutral person-outline icon (not a generated graphic, not a letter).
const AvatarThumb = ({ url }: { url?: string | null }) => (
  url ? <img className="avatar-img" src={url} alt="" /> : <UserIcon size={14} strokeWidth={1.8} />
)

const FONTS = ['default', 'serif', 'mono', 'georgia', 'impact', 'comic', 'courier', 'fantasy', 'trebuchet']
const COLORS = ['purple', 'blue', 'green', 'orange', 'red', 'pink', 'teal', 'yellow', 'indigo']
const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'MEMBER']

export default function DashboardApp() {
  const { user, setUser, logout: authLogout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceDescription, setWorkspaceDescription] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [taskPriority, setTaskPriority] = useState('MEDIUM')
  const [taskDueDate, setTaskDueDate] = useState('')
  const [taskTime, setTaskTime] = useState('')
  const [taskAssignedTo, setTaskAssignedTo] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('MEMBER')
  const [myInvitations, setMyInvitations] = useState<Invitation[]>([])
  const [workspaceInvitations, setWorkspaceInvitations] = useState<Invitation[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [navPage, setNavPage] = useState<NavPage>('dashboard')
  const [notifCount, setNotifCount] = useState(0)
  const [notifList, setNotifList] = useState<NotifItem[]>([])
  const [showNotifs, setShowNotifs] = useState(false)
  const [pendingOpenTaskId, setPendingOpenTaskId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>({ pushEnabled: true, soundEnabled: true, vibrationEnabled: true, defaultReminderMinutes: [15] })
  const [pushPermission, setPushPermission] = useState(getNotificationPermission())
  const [taskReminderOffsets, setTaskReminderOffsets] = useState<number[]>([15])
  const [taskCustomReminderAt, setTaskCustomReminderAt] = useState('')
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState<'info' | 'success' | 'error'>('info')
  const [reportsSummary, setReportsSummary] = useState<{ total: number; completed: number; inProgress: number; overdue: number } | null>(null)
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [workspacePlan, setWorkspacePlan] = useState<WorkspacePlan>(DEFAULT_PLAN)
  const [taskRecurrence, setTaskRecurrence] = useState<RecurrenceConfig>(DEFAULT_RECURRENCE)
  const [focusTask, setFocusTask] = useState<FocusTask | null>(null)
  const [reportFrom, setReportFrom] = useState('')
  const [reportTo, setReportTo] = useState('')
  const [activitySearch, setActivitySearch] = useState('')
  const [activityFrom, setActivityFrom] = useState('')
  const [activityTo, setActivityTo] = useState('')
  const [loadingDashboard, setLoadingDashboard] = useState(true)
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [onboardingActive, setOnboardingActive] = useState(false)
  const [isOffline, setIsOffline] = useState(!isOnline())
  const [pendingSyncCount, setPendingSyncCount] = useState(0)

  // Settings state — seeded once from the authenticated user (ProtectedRoute
  // guarantees `user` is already loaded before this component mounts).
  const [settingsName, setSettingsName] = useState(() => user?.firstname || '')
  const [settingsLast, setSettingsLast] = useState(() => user?.lastName || '')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarFileInputRef = useRef<HTMLInputElement>(null)
  const [settingsLang, setSettingsLang] = useState(() => user?.language || 'en')
  const [settingsFont, setSettingsFont] = useState(() => user?.fontStyle || 'default')
  const [settingsColor, setSettingsColor] = useState(() => user?.colorTheme || 'purple')
  const [taskNotificationsEnabled, setTaskNotificationsEnabled] = useState(() => user?.taskNotificationsEnabled ?? true)
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(() => user?.emailNotificationsEnabled ?? true)

  const showMessage = useCallback((msg: string, type: 'info' | 'success' | 'error' = 'info') => {
    setMessage(msg); setMessageType(type)
    setTimeout(() => setMessage(''), 2500)
  }, [])

  const request = useCallback(async (input: string, init?: RequestInit) => {
    try {
      return await authFetch(input, init)
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await authLogout()
        navigate('/login')
      }
      throw err
    }
  }, [authLogout, navigate])

  const loadWorkspaces = useCallback(async () => {
    try {
      const d = await request('/api/workspaces') as { workspaces: Workspace[] }
      setWorkspaces(d.workspaces || [])
      setSelectedWorkspaceId(prev => prev || d.workspaces?.[0]?.id || '')
    } catch { setWorkspaces([]) }
    finally { setWorkspacesLoaded(true) }
  }, [request])

  const loadTasks = useCallback(async () => {
    if (!selectedWorkspaceId) return
    try {
      const d = await request(`/api/tasks?workspaceId=${selectedWorkspaceId}`) as { tasks: Task[] }
      setTasks(d.tasks || [])
      setIsOffline(false)
      void cacheTasks(selectedWorkspaceId, d.tasks || [])
    } catch (err) {
      // A TypeError from `fetch` itself (not an HTTP error response) means
      // the network is unreachable — fall back to whatever we last cached
      // for this workspace instead of clearing the list to empty.
      if (err instanceof TypeError) {
        setIsOffline(true)
        const cached = await getCachedTasks(selectedWorkspaceId)
        setTasks(cached as unknown as Task[])
      } else {
        setTasks([])
      }
    } finally {
      setLoadingDashboard(false)
    }
  }, [request, selectedWorkspaceId])

  const loadPlan = useCallback(async () => {
    if (!selectedWorkspaceId) return
    try {
      const d = await request(`/api/billing/workspaces/${selectedWorkspaceId}/subscription`) as { subscription: { plan: WorkspacePlan } | null }
      setWorkspacePlan(d.subscription?.plan || DEFAULT_PLAN)
    } catch { setWorkspacePlan(DEFAULT_PLAN) }
  }, [request, selectedWorkspaceId])


  const loadMyInvitations = useCallback(async () => {
    try { const d = await request('/api/invitations/mine') as { invitations: Invitation[] }; setMyInvitations(d.invitations || []) } catch { setMyInvitations([]) }
  }, [request])

  const loadWorkspaceInvitations = useCallback(async () => {
    if (!selectedWorkspaceId) return
    try { const d = await request(`/api/invitations/workspace/${selectedWorkspaceId}`) as { invitations: Invitation[] }; setWorkspaceInvitations(d.invitations || []) } catch { setWorkspaceInvitations([]) }
  }, [request, selectedWorkspaceId])

  const loadMembers = useCallback(async () => {
    if (!selectedWorkspaceId) return
    try { const d = await request(`/api/workspaces/${selectedWorkspaceId}/members`) as { members: Member[] }; setMembers(d.members || []) } catch { setMembers([]) }
  }, [request, selectedWorkspaceId])

  const loadNotifs = useCallback(async () => {
    try { const d = await request('/api/notifications/unread-count') as { count: number }; setNotifCount(d.count ?? 0) } catch { /* ignore */ }
  }, [request])

  const loadNotifList = useCallback(async () => {
    try { const d = await request('/api/notifications') as { notifications: typeof notifList }; setNotifList(d.notifications || []) } catch { /* ignore */ }
  }, [request])

  const loadNotifPrefs = useCallback(async () => {
    try { const d = await request('/api/settings/notification-preferences') as { preferences: NotificationPreferences }; if (d.preferences) setNotifPrefs(d.preferences) } catch { /* ignore */ }
  }, [request])

  const loadReports = useCallback(async () => {
    try { const d = await request('/api/reports') as { summary: typeof reportsSummary }; setReportsSummary(d.summary) } catch { setReportsSummary(null) }
  }, [request])

  const loadActivity = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (activitySearch.trim()) params.set('search', activitySearch.trim())
      if (activityFrom) params.set('from', new Date(activityFrom).toISOString())
      if (activityTo) params.set('to', new Date(activityTo).toISOString())
      const d = await request(`/api/activity?${params.toString()}`) as { activity: ActivityEntry[] }
      setActivityLog(d.activity || [])
    } catch { setActivityLog([]) }
  }, [request, activitySearch, activityFrom, activityTo])

  const loadSessions = useCallback(async () => {
    try {
      const refreshToken = localStorage.getItem('taskmanager_refresh_token') || ''
      const d = await request(`/api/auth/sessions?refreshToken=${encodeURIComponent(refreshToken)}`) as { sessions: Session[] }
      setSessions(d.sessions || [])
    } catch { setSessions([]) }
  }, [request])

  // These fetch-on-mount / fetch-on-tab-change effects call async loaders whose
  // setState calls happen after an await, not synchronously during the effect —
  // safe, but the lint rule can't distinguish that from a genuine sync setState.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadWorkspaces(); loadMyInvitations(); loadNotifs(); loadNotifPrefs() }, [loadWorkspaces, loadMyInvitations, loadNotifs, loadNotifPrefs])
  // Onboarding kicks in the first time we know for certain the account has
  // zero workspaces — once triggered it stays on its own state (not tied
  // directly to workspace count) so the wizard's later steps aren't yanked
  // away the instant the workspace-creation step succeeds.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (workspacesLoaded && workspaces.length === 0) setOnboardingActive(true) }, [workspacesLoaded, workspaces.length])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLoadingDashboard(true) }, [selectedWorkspaceId])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadTasks(); loadMembers(); loadWorkspaceInvitations(); loadPlan() }, [loadTasks, loadMembers, loadWorkspaceInvitations, loadPlan])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (navPage === 'reports') loadReports() }, [navPage, loadReports])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (navPage === 'activity') loadActivity() }, [navPage, loadActivity])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (navPage === 'notifications') loadNotifList() }, [navPage, loadNotifList])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (navPage === 'settings') loadSessions() }, [navPage, loadSessions])

  // Web Push (see PUSH_RECEIVED handling below) is the real-time path now
  // that every notification type triggers a push, not just due-date
  // reminders — this poll only exists as a fallback for tabs where the
  // user hasn't granted notification permission, so it can stay short
  // without meaningfully increasing server load.
  useEffect(() => {
    const interval = setInterval(loadNotifs, 15000)
    return () => clearInterval(interval)
  }, [loadNotifs])

  // Offline sync: replay whatever's queued the moment the browser reports
  // connectivity again, then refresh from the server and let the user know
  // it actually happened (requirement: "notify users of successful sync").
  useEffect(() => {
    const handleOnline = async () => {
      setIsOffline(false)
      const { synced, failed } = await syncOutbox(request)
      if (synced > 0) {
        showMessage(`Synced ${synced} offline change${synced === 1 ? '' : 's'}`, 'success')
        await loadTasks()
      }
      if (failed > 0) showMessage('Some offline changes could not be synced yet', 'error')
      setPendingSyncCount(await getOutboxCount())
    }
    const handleOffline = () => setIsOffline(true)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    getOutboxCount().then(setPendingSyncCount)
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  // Requirement: "Request notification permission from users after login."
  // DashboardApp only mounts once ProtectedRoute confirms an authenticated
  // user, so a one-time permission prompt here satisfies that without
  // re-asking every time the tab reloads (`Notification.permission` stops
  // being 'default' once the user has answered, granted or denied).
  useEffect(() => {
    if (getNotificationPermission() !== 'default') return
    subscribeToPush().then(ok => { if (ok) { setPushPermission(getNotificationPermission()); loadNotifPrefs() } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bridges service-worker push events (and notification-action results)
  // back into the page: an in-app toast while Taskly is open, plus
  // refreshing whatever list the action affected.
  useEffect(() => {
    const off = onServiceWorkerMessage((msg: ServiceWorkerMessage) => {
      if (msg.type === 'PUSH_RECEIVED') {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        setToasts(prev => [...prev, { id, title: msg.title, body: msg.body, taskId: msg.data?.taskId }])
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 8000)
        loadNotifs(); if (navPage === 'notifications' || showNotifs) loadNotifList()
      } else if (msg.type === 'TASK_COMPLETED') {
        loadTasks(); loadNotifs()
      } else if (msg.type === 'REMINDER_SNOOZED') {
        showMessage('Reminder snoozed for 10 minutes', 'info')
      } else if (msg.type === 'NAVIGATE') {
        setNavPage('tasks')
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navPage, showNotifs])

  // Stripe/PayPal/Flutterwave checkout redirects land on /app/billing (the
  // static success/cancel URL configured server-side) — open the Billing
  // tab automatically so the returning user sees the result there.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (location.pathname.startsWith('/app/billing')) setNavPage('billing') }, [location.pathname])


  const handleCreateWorkspace = async (e: FormEvent<HTMLFormElement>): Promise<boolean> => {
    e.preventDefault()
    try {
      const d = await request('/api/workspaces', {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ name: workspaceName, description: workspaceDescription }),
      }) as { workspace: Workspace }
      setWorkspaceName(''); setWorkspaceDescription(''); setSelectedWorkspaceId(d.workspace.id)
      await loadWorkspaces(); showMessage('Workspace created', 'success')
      return true
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to create workspace', 'error'); return false }
  }

  const handleCreateTask = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try {
      let dueDateTime = taskDueDate || null
      if (dueDateTime && taskTime) dueDateTime = `${taskDueDate}T${taskTime}:00`
      const body: Record<string, unknown> = {
        title: taskTitle, description: taskDescription, priority: taskPriority,
        dueDate: dueDateTime, workspaceId: selectedWorkspaceId,
      }
      if (taskAssignedTo) body.assignedToId = taskAssignedTo
      if (dueDateTime) {
        body.reminderOffsets = taskReminderOffsets
        if (taskCustomReminderAt) body.customReminderTimes = [new Date(taskCustomReminderAt).toISOString()]
      }
      if (taskRecurrence.isRecurring) {
        body.isRecurring = true
        body.recurrenceRule = taskRecurrence.recurrenceRule
        body.recurrenceInterval = taskRecurrence.recurrenceInterval
        body.recurrenceDaysOfWeek = taskRecurrence.recurrenceDaysOfWeek
        body.recurrenceBusinessDaysOnly = taskRecurrence.recurrenceBusinessDaysOnly
        if (taskRecurrence.recurrenceEndDate) body.recurrenceEndDate = taskRecurrence.recurrenceEndDate
        if (taskRecurrence.recurrenceCount) body.recurrenceCount = taskRecurrence.recurrenceCount
      }
      const resetForm = () => {
        setTaskTitle(''); setTaskDescription(''); setTaskPriority('MEDIUM'); setTaskDueDate(''); setTaskTime(''); setTaskAssignedTo('')
        setTaskReminderOffsets(notifPrefs.defaultReminderMinutes.length ? notifPrefs.defaultReminderMinutes : [15]); setTaskCustomReminderAt('')
        setTaskRecurrence(DEFAULT_RECURRENCE)
      }

      try {
        await request('/api/tasks', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
        resetForm()
        await loadTasks(); showMessage('Task added', 'success')
      } catch (err) {
        if (!(err instanceof TypeError)) throw err
        // Offline: queue the create and show it locally right away — synced
        // automatically once connectivity returns (see the 'online' effect).
        const clientId = crypto.randomUUID()
        await queueMutation({ type: 'create', clientId, workspaceId: selectedWorkspaceId, payload: body })
        const optimisticTask: Task = {
          id: `offline-${clientId}`, title: taskTitle, description: taskDescription, status: 'TODO', priority: taskPriority,
          workspaceId: selectedWorkspaceId, dueDate: dueDateTime, assignedToId: taskAssignedTo || null,
        }
        setTasks(prev => [optimisticTask, ...prev])
        await upsertCachedTask(optimisticTask as unknown as Record<string, unknown> & { id: string; workspaceId: string })
        setPendingSyncCount(await getOutboxCount())
        resetForm()
        showMessage("You're offline — task saved locally and will sync automatically", 'info')
      }
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to create task', 'error') }
  }

  const handleMoveTask = async (taskId: string, nextStatus: string) => {
    try {
      const d = await request(`/api/tasks/${taskId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: nextStatus }) }) as {
        nextOccurrence?: { dueDate: string } | null
        newAchievements?: { name: string }[]
      }
      await loadTasks()
      if (d.newAchievements && d.newAchievements.length > 0) {
        showMessage(`Achievement unlocked: ${d.newAchievements.map(a => a.name).join(', ')}`, 'success')
      } else if (d.nextOccurrence) {
        showMessage(`Task completed — next occurrence scheduled for ${new Date(d.nextOccurrence.dueDate).toLocaleDateString()}`, 'success')
      }
    } catch (err) {
      if (!(err instanceof TypeError)) {
        showMessage(err instanceof Error ? err.message : 'Unable to update task', 'error')
        return
      }
      // Offline: queue the status change and reflect it immediately.
      await queueMutation({ type: 'update', taskId, payload: { status: nextStatus } })
      const updated = tasks.map(tk => tk.id === taskId ? { ...tk, status: nextStatus, completedAt: nextStatus === 'COMPLETED' ? new Date().toISOString() : null } : tk)
      setTasks(updated)
      const changed = updated.find(tk => tk.id === taskId)
      if (changed) await upsertCachedTask(changed as unknown as Record<string, unknown> & { id: string; workspaceId: string })
      setPendingSyncCount(await getOutboxCount())
      showMessage("You're offline — change saved locally and will sync automatically", 'info')
    }
  }

  const handleSubtaskToggle = async (subtaskId: string, completed: boolean) => {
    try {
      await request(`/api/tasks/${subtaskId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: completed ? 'COMPLETED' : 'TODO' }) })
      await loadTasks()
      setFocusTask(prev => prev ? { ...prev, subtasks: prev.subtasks.map(s => s.id === subtaskId ? { ...s, status: completed ? 'COMPLETED' : 'TODO' } : s) } : prev)
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to update subtask', 'error') }
  }

  const handleFocusComplete = async () => {
    if (!focusTask) return
    await handleMoveTask(focusTask.id, 'COMPLETED')
    setFocusTask(prev => prev ? { ...prev, status: 'COMPLETED' } : prev)
  }

  const openFocusMode = (task: Task) => {
    setFocusTask({ id: task.id, title: task.title, description: task.description, status: task.status, subtasks: task.subtasks || [] })
    setSelectedTask(null)
  }

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Delete this task?')) return
    try {
      await request(`/api/tasks/${taskId}`, { method: 'DELETE' })
      await loadTasks(); showMessage('Task deleted', 'info')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to delete task', 'error') }
  }

  const handleInviteMember = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!selectedWorkspaceId) return
    try {
      const d = await request('/api/invitations', {
        method: 'POST', headers: jsonHeaders,
        body: JSON.stringify({ email: inviteEmail, workspaceId: selectedWorkspaceId, role: inviteRole }),
      }) as { message: string }
      setInviteEmail(''); showMessage(d.message || 'Invitation sent', 'success'); await loadWorkspaceInvitations()
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to send invitation', 'error') }
  }

  const handleAcceptInvitation = async (token: string) => {
    try {
      const d = await request(`/api/invitations/${token}/accept`, { method: 'POST' }) as { message: string }
      showMessage(d.message || 'Joined workspace', 'success'); await loadMyInvitations(); await loadWorkspaces()
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to accept', 'error') }
  }

  const handleCancelInvitation = async (id: string) => {
    try {
      await request(`/api/invitations/${id}`, { method: 'DELETE' })
      showMessage('Invitation cancelled', 'info'); await loadWorkspaceInvitations()
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to cancel', 'error') }
  }

  const handleResendInvitation = async (id: string) => {
    try {
      const d = await request(`/api/invitations/${id}/resend`, { method: 'POST' }) as { message: string }
      showMessage(d.message || 'Invitation resent', 'success'); await loadWorkspaceInvitations()
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to resend', 'error') }
  }

  const handleUpdateMemberRole = async (memberId: string, role: string) => {
    try {
      await request(`/api/workspaces/${selectedWorkspaceId}/members/${memberId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ role }) })
      await loadMembers(); showMessage('Member role updated', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to update role', 'error') }
  }

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Remove this member from the workspace?')) return
    try {
      await request(`/api/workspaces/${selectedWorkspaceId}/members/${memberId}`, { method: 'DELETE' })
      await loadMembers(); showMessage('Member removed', 'info')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to remove member', 'error') }
  }

  const handleSaveSettings = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try {
      const d = await request('/api/settings/profile', {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({
          firstname: settingsName, lastName: settingsLast,
          language: settingsLang, fontStyle: settingsFont, colorTheme: settingsColor,
          taskNotificationsEnabled, emailNotificationsEnabled,
        }),
      }) as { user: typeof user }
      if (d.user) setUser(d.user)
      showMessage('Settings saved', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to save', 'error') }
  }

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarUploading(true)
    try {
      const form = new FormData()
      form.append('avatar', file)
      const token = getStoredToken()
      const response = await fetch('/api/settings/avatar', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || 'Upload failed')
      if (data.user) setUser(data.user)
      showMessage('Profile photo updated', 'success')
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Unable to upload photo', 'error')
    } finally {
      setAvatarUploading(false)
    }
  }

  const handleAvatarRemove = async () => {
    try {
      const d = await request('/api/settings/avatar', { method: 'DELETE' }) as { user: typeof user }
      if (d.user) setUser(d.user)
      showMessage('Profile photo removed', 'info')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to remove photo', 'error') }
  }

  // Language applies to every t(...) call across the whole app instantly via
  // this state update, but — unlike font/color, which only ever change what
  // this browser renders — a language choice that isn't persisted would
  // silently revert to the account's saved value on next login. Saved
  // immediately on selection rather than requiring the separate "Save
  // preferences" submit, so it sticks until explicitly changed again.
  const handleLanguageChange = async (lang: string) => {
    setSettingsLang(lang)
    try {
      const d = await request('/api/settings/profile', {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ language: lang }),
      }) as { user: typeof user }
      if (d.user) setUser(d.user)
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Unable to save language preference', 'error')
    }
  }

  const handleChangePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try {
      const d = await request('/api/settings/password', {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({ currentPassword, newPassword }),
      }) as { message: string }
      setCurrentPassword(''); setNewPassword('')
      showMessage(d.message || 'Password changed', 'success')
      await loadSessions()
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to change password', 'error') }
  }

  const handleRevokeSession = async (id: string) => {
    try {
      await request(`/api/auth/sessions/${id}`, { method: 'DELETE' })
      await loadSessions(); showMessage('Session revoked', 'info')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to revoke session', 'error') }
  }

  const handleLogoutAllDevices = async () => {
    if (!confirm('This will sign you out on every device, including this one. Continue?')) return
    try {
      await request('/api/auth/logout-all', { method: 'POST' })
      await authLogout(); navigate('/login')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to log out everywhere', 'error') }
  }

  const handleTogglePush = async (enabled: boolean) => {
    if (enabled) {
      const ok = await subscribeToPush()
      setPushPermission(getNotificationPermission())
      if (!ok) {
        showMessage(getNotificationPermission() === 'denied' ? 'Notifications are blocked in your browser settings' : 'Unable to enable push notifications', 'error')
        return
      }
    } else {
      await unsubscribeFromPush()
    }
    try {
      const d = await request('/api/settings/notification-preferences', {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ pushEnabled: enabled }),
      }) as { preferences: NotificationPreferences }
      if (d.preferences) setNotifPrefs(d.preferences)
      showMessage(enabled ? 'Push notifications enabled' : 'Push notifications disabled', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to save preference', 'error') }
  }

  const handleSaveNotifPrefs = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    try {
      const d = await request('/api/settings/notification-preferences', {
        method: 'PATCH', headers: jsonHeaders,
        body: JSON.stringify({ soundEnabled: notifPrefs.soundEnabled, vibrationEnabled: notifPrefs.vibrationEnabled, defaultReminderMinutes: notifPrefs.defaultReminderMinutes }),
      }) as { preferences: NotificationPreferences }
      if (d.preferences) setNotifPrefs(d.preferences)
      showMessage('Notification preferences saved', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to save preferences', 'error') }
  }

  const toggleDefaultReminderMinute = (minutes: number) => {
    setNotifPrefs(prev => ({
      ...prev,
      defaultReminderMinutes: prev.defaultReminderMinutes.includes(minutes)
        ? prev.defaultReminderMinutes.filter(m => m !== minutes)
        : [...prev.defaultReminderMinutes, minutes].sort((a, b) => a - b),
    }))
  }

  const toggleTaskReminderOffset = (minutes: number) => {
    setTaskReminderOffsets(prev => prev.includes(minutes) ? prev.filter(m => m !== minutes) : [...prev, minutes].sort((a, b) => a - b))
  }

  const handleSendTestPush = async () => {
    try {
      await sendTestPush()
      showMessage('Test notification sent — check your device', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to send test notification', 'error') }
  }

  const handleMarkNotifRead = async (id: string) => {
    try {
      await request(`/api/notifications/${id}/read`, { method: 'PATCH' })
      setNotifList(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n))
      setNotifCount(prev => Math.max(0, prev - 1))
    } catch { /* ignore */ }
  }

  const handleMarkAllRead = async () => {
    try {
      await request('/api/notifications/read-all', { method: 'POST' })
      setNotifCount(0); setNotifList(prev => prev.map(n => ({ ...n, isRead: true })))
    } catch { /* ignore */ }
  }

  // "Open task" from a notification card — the task may belong to a
  // workspace other than the one currently selected, so switch to it first
  // and defer opening the detail panel until that workspace's tasks have
  // actually loaded (handled by the effect below watching `tasks`).
  const handleOpenNotifTask = (n: NotifItem) => {
    if (!n.taskId) return
    if (!n.isRead) handleMarkNotifRead(n.id)
    setShowNotifs(false)
    if (n.workspaceId && n.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(n.workspaceId)
      setPendingOpenTaskId(n.taskId)
      setNavPage('tasks')
      return
    }
    const found = tasks.find(tk => tk.id === n.taskId)
    if (found) setSelectedTask(found)
    else { setPendingOpenTaskId(n.taskId); setNavPage('tasks') }
  }

  useEffect(() => {
    if (!pendingOpenTaskId) return
    const found = tasks.find(tk => tk.id === pendingOpenTaskId)
    if (found) { setSelectedTask(found); setPendingOpenTaskId(null) }
  }, [tasks, pendingOpenTaskId])

  const handleCompleteFromNotif = async (n: NotifItem) => {
    if (!n.taskId) return
    if (!n.isRead) handleMarkNotifRead(n.id)
    await handleMoveTask(n.taskId, 'COMPLETED')
    setNotifList(prev => prev.map(item => item.id === n.id && item.task ? { ...item, task: { ...item.task, status: 'COMPLETED' } } : item))
  }

  const logout = async () => { await authLogout(); navigate('/login') }

  const handleExport = async (type: 'tasks' | 'workspaces' | 'report', format: 'csv' | 'json' | 'xlsx' | 'pdf', range?: { from?: string; to?: string }) => {
    try {
      const token = getStoredToken()
      const params = new URLSearchParams({ type, format })
      if (type !== 'workspaces') params.set('workspaceId', selectedWorkspaceId)
      if (range?.from) params.set('from', new Date(range.from).toISOString())
      if (range?.to) params.set('to', new Date(range.to).toISOString())
      const response = await fetch(`/api/export?${params.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.message || 'Export failed')
      }
      const blob = format === 'json' ? new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' }) : await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${type}-export.${format}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      showMessage('Export downloaded', 'success')
    } catch (err) { showMessage(err instanceof Error ? err.message : 'Unable to export', 'error') }
  }

  const trendData: TrendPoint[] = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date()
      d.setDate(d.getDate() - (6 - i))
      return d
    })
    // Bucket by when a task was actually completed (completedAt), not its
    // due date — a task due Monday but finished Thursday is a Thursday
    // completion, and a completed task with no due date should still show
    // up somewhere. completedAt is only missing for tasks completed before
    // that column existed; updatedAt is the closest fallback signal for those.
    return days.map(d => ({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      completed: tasks.filter(tk => {
        if (tk.status !== 'COMPLETED') return false
        const completedOn = tk.completedAt || tk.updatedAt
        return !!completedOn && new Date(completedOn).toDateString() === d.toDateString()
      }).length,
    }))
  }, [tasks])

  if (!user) return null

  const selectedWs = workspaces.find(w => w.id === selectedWorkspaceId)
  const myTasks = tasks.filter(tk => tk.assignedToId === user.id)
  const overdueTasks = tasks.filter(tk => tk.dueDate && new Date(tk.dueDate) < new Date() && tk.status !== 'COMPLETED')
  const upcomingDeadlines = tasks.filter(tk => tk.dueDate).sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime()).slice(0, 5)

  const todayStr = new Date().toDateString()
  const dueTodayCount = tasks.filter(tk => tk.dueDate && tk.status !== 'COMPLETED' && new Date(tk.dueDate).toDateString() === todayStr).length
  const in7Days = new Date(); in7Days.setDate(in7Days.getDate() + 7)
  const upcomingWeekCount = tasks.filter(tk => tk.dueDate && tk.status !== 'COMPLETED' && new Date(tk.dueDate) > new Date() && new Date(tk.dueDate) <= in7Days).length
  const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toDateString() })()
  const completedYesterdayCount = tasks.filter(tk => tk.completedAt && new Date(tk.completedAt).toDateString() === yesterdayStr).length
  const productivityDeltaPercent = (() => {
    const now = new Date().getTime(); const oneWeekMs = 7 * 24 * 60 * 60 * 1000
    const thisWeek = tasks.filter(tk => tk.completedAt && (now - new Date(tk.completedAt).getTime()) < oneWeekMs).length
    const lastWeek = tasks.filter(tk => tk.completedAt && (now - new Date(tk.completedAt).getTime()) >= oneWeekMs && (now - new Date(tk.completedAt).getTime()) < 2 * oneWeekMs).length
    if (lastWeek === 0) return null
    return Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
  })()
  const myMembership = members.find(m => m.userId === user.id)
  const canManageMembers = myMembership && (myMembership.role === 'OWNER' || myMembership.role === 'ADMIN')

  const totalTasks = tasks.length
  const completedTasks = tasks.filter(tk => tk.status === 'COMPLETED').length
  const inProgressTasks = tasks.filter(tk => tk.status === 'IN_PROGRESS').length
  const todoTasks = tasks.filter(tk => tk.status === 'TODO').length
  const reviewTasks = tasks.filter(tk => tk.status === 'REVIEW').length
  const statusCounts: StatusCounts = { total: totalTasks, completed: completedTasks, inProgress: inProgressTasks, todo: todoTasks, overdue: overdueTasks.length, review: reviewTasks }
  const reportStatusCounts: StatusCounts = reportsSummary
    ? { total: reportsSummary.total, completed: reportsSummary.completed, inProgress: reportsSummary.inProgress, todo: Math.max(reportsSummary.total - reportsSummary.completed - reportsSummary.inProgress, 0), overdue: reportsSummary.overdue }
    : statusCounts

  const themeClass = `theme-${settingsColor || 'purple'} font-${settingsFont || 'default'}`

  return (
    <main className={`dashboard-shell ${themeClass}`}>
      {toasts.length > 0 && (
        <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
          {toasts.map(toast => (
            <div key={toast.id} className="toast-card" role="button" tabIndex={0}
              onClick={() => { if (toast.taskId) setNavPage('tasks'); setToasts(prev => prev.filter(t => t.id !== toast.id)) }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (toast.taskId) setNavPage('tasks'); setToasts(prev => prev.filter(t => t.id !== toast.id)) } }}
            >
              <BellRing size={16} strokeWidth={1.8} />
              <div className="toast-card-body">
                <strong>{toast.title}</strong>
                <span>{toast.body}</span>
              </div>
              <button type="button" className="toast-close" onClick={e => { e.stopPropagation(); setToasts(prev => prev.filter(t => t.id !== toast.id)) }} aria-label="Dismiss notification"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {selectedWorkspaceId && (
        <QuickCapture
          workspaces={workspaces} selectedWorkspaceId={selectedWorkspaceId} onCreated={loadTasks} onMessage={showMessage}
          workspaceName={workspaceName} setWorkspaceName={setWorkspaceName}
          workspaceDescription={workspaceDescription} setWorkspaceDescription={setWorkspaceDescription}
          onCreateWorkspace={handleCreateWorkspace}
        />
      )}
      <InstallPrompt />
      {focusTask && (
        <FocusMode
          task={focusTask}
          onClose={() => setFocusTask(null)}
          onComplete={handleFocusComplete}
          onSubtaskToggle={handleSubtaskToggle}
          onMessage={showMessage}
        />
      )}
      {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <p className="eyebrow">Taskly</p>
          <h2>{user.firstname} {user.lastName}</h2>
          <p>{selectedWs?.name || t('overview', settingsLang)}</p>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(({ page, icon: Icon }) => (
            <button key={page} className={`nav-item ${navPage === page ? 'active' : ''}`} onClick={() => { setNavPage(page); setMobileNavOpen(false) }} title={sidebarCollapsed ? t(page === 'tasks' ? 'myTasks' : page, settingsLang) : undefined}>
              <span className="nav-icon"><Icon size={17} strokeWidth={1.8} /></span>
              <span className="nav-label">{t(page === 'tasks' ? 'myTasks' : page, settingsLang)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar">
              <AvatarThumb url={user.avatarUrl} />
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{user.firstname}</div>
              <div className="sidebar-user-email">{user.email}</div>
            </div>
          </div>
          <button className="logout-btn" onClick={logout} title="Sign out"><LogOut size={16} /></button>
        </div>
        <button type="button" className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(v => !v)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <ChevronLeft size={14} style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s ease' }} />
        </button>
      </aside>

      <div className="main-area">
        <div className="main-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" className="mobile-menu-btn" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <Menu size={20} />
            </button>
            <div>
              {navPage !== 'dashboard' && <h1>{greeting(settingsLang)}, {user.firstname} 🫠</h1>}
              <p>{selectedWs?.name || ''}</p>
            </div>
          </div>
          <div className="main-topbar-actions">
            <div className="workspace-selector">
              {workspaces.map(ws => (
                <button key={ws.id} type="button"
                  className={`workspace-chip ${selectedWorkspaceId === ws.id ? 'active' : ''}`}
                  onClick={() => setSelectedWorkspaceId(ws.id)}>
                  {ws.name}
                </button>
              ))}
            </div>
            <div className="notif-bell">
              <button
                type="button" className="notif-bell-btn"
                onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs) loadNotifList() }}
                aria-haspopup="true" aria-expanded={showNotifs}
                aria-label={notifCount > 0 ? `Notifications, ${notifCount} unread` : 'Notifications'}
              >
                <Bell size={18} strokeWidth={1.8} />
                {notifCount > 0 && <span className="notif-badge">{notifCount}</span>}
              </button>
              {showNotifs && (
                <div className="notif-dropdown">
                  <div className="notif-dropdown-header">
                    <strong>Notifications</strong>
                    {notifCount > 0 && <button className="mini-btn" onClick={handleMarkAllRead}>Mark all read</button>}
                  </div>
                  {notifList.length === 0 ? (
                    <EmptyState kind="notifications" compact title="You're all caught up" description="New activity on your tasks will show up here." />
                  ) : (
                    <div className="notif-card-list">
                      {notifList.slice(0, 10).map(n => (
                        <NotificationCard key={n.id} notif={n} compact onOpenTask={handleOpenNotifTask} onComplete={handleCompleteFromNotif} onMarkRead={handleMarkNotifRead} />
                      ))}
                    </div>
                  )}
                  <button type="button" className="mini-btn" style={{ width: '100%', marginTop: 8 }} onClick={() => { setShowNotifs(false); setNavPage('notifications') }}>View all notifications</button>
                </div>
              )}
            </div>
            <div className="topbar-avatar" onClick={() => setNavPage('settings')} title={t('settings', settingsLang)}>
              <div className="sidebar-avatar">
                <AvatarThumb url={user.avatarUrl} />
              </div>
            </div>
          </div>
        </div>

        <div className="main-content">
          {myInvitations.length > 0 && (
            <div className="invite-banner">
              <h3>{t('pendingInvites', settingsLang)}</h3>
              {myInvitations.map(inv => (
                <div key={inv.id} className="invite-banner-item">
                  <span>{t('welcome', settingsLang)} <strong>{inv.workspace?.name || ''}</strong></span>
                  <button type="button" className="mini-btn accept-btn" onClick={() => handleAcceptInvitation(inv.token)}>Accept</button>
                </div>
              ))}
            </div>
          )}

          {isOffline && (
            <div className="offline-banner">
              <WifiOff size={14} strokeWidth={1.8} />
              <span>You're offline — showing your last-loaded tasks. Changes you make will sync automatically once you're back online.</span>
            </div>
          )}
          {!isOffline && pendingSyncCount > 0 && (
            <div className="offline-banner syncing">
              <RefreshCw size={14} strokeWidth={1.8} />
              <span>{pendingSyncCount} change{pendingSyncCount === 1 ? '' : 's'} waiting to sync…</span>
            </div>
          )}

          {message && <div className={`message-bar ${messageType}`} role="status" aria-live="polite">{message}</div>}

          {navPage === 'dashboard' && (
            <>
              <SmartDashboardHeader
                firstname={user.firstname}
                dueTodayCount={dueTodayCount}
                overdueCount={overdueTasks.length}
                upcomingCount={upcomingWeekCount}
                completedYesterdayCount={completedYesterdayCount}
                productivityDeltaPercent={productivityDeltaPercent}
                translations={{ morning: t('morning', settingsLang), afternoon: t('afternoon', settingsLang), evening: t('evening', settingsLang) }}
              />

              {onboardingActive ? (
                <OnboardingWizard
                  firstname={user.firstname}
                  workspaceName={workspaceName} setWorkspaceName={setWorkspaceName}
                  workspaceDescription={workspaceDescription} setWorkspaceDescription={setWorkspaceDescription}
                  onCreateWorkspace={handleCreateWorkspace}
                  languages={LANGUAGES} settingsLang={settingsLang} onLanguageChange={handleLanguageChange}
                  settingsColor={settingsColor} onColorChange={c => { setSettingsColor(c); document.documentElement.setAttribute('data-theme', c) }}
                  onFinish={() => setOnboardingActive(false)}
                />
              ) : (
                <>
              <div className="dashboard-grid">
                <div className="panel full-width">
                  <h2>{t('overview', settingsLang)}</h2>
                  {loadingDashboard ? <SkeletonStatCards /> : <StatSummaryCards counts={statusCounts} myTasks={myTasks.length} teamMembers={members.length} />}
                </div>
              </div>

              <div className="dashboard-grid">
                <div className="panel">
                  <h2>{t('progress', settingsLang)}</h2>
                  <Suspense fallback={<SkeletonChart />}><StatusDoughnutChart counts={statusCounts} /></Suspense>
                </div>
                <div className="panel">
                  <h2>Completed this week</h2>
                  <Suspense fallback={<SkeletonChart />}><CompletionTrendChart data={trendData} /></Suspense>
                </div>
              </div>

              <div className="dashboard-grid">
                <div className="panel">
                  <h2>{t('recentTasks', settingsLang)}</h2>
                  {loadingDashboard ? <SkeletonList rows={3} /> : (
                    <>
                      {tasks.slice(0, 5).map(tk => (
                        <div key={tk.id} className="recent-task-item">
                          <strong>{tk.title}</strong>
                          <span className={`priority-badge ${tk.priority.toLowerCase()}`}>{tk.priority}</span>
                          <span className={`status-badge ${tk.status.toLowerCase()}`}>{tk.status.replace('_', ' ')}</span>
                        </div>
                      ))}
                      {tasks.length === 0 && (
                        <EmptyState kind="tasks" compact title="You're all caught up" description="Create your next task to stay organized." />
                      )}
                    </>
                  )}
                </div>

                <div className="panel">
                  <h2>{t('deadlines', settingsLang)}</h2>
                  {upcomingDeadlines.map(tk => (
                    <div key={tk.id} className="recent-task-item">
                      <strong>{tk.title}</strong>
                      <span>{new Date(tk.dueDate!).toLocaleDateString()} {tk.dueDate!.includes('T') ? new Date(tk.dueDate!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </div>
                  ))}
                  {upcomingDeadlines.length === 0 && (
                    <EmptyState kind="success" compact title="Nothing on the horizon" description="Deadlines you set will appear here." />
                  )}
                </div>
              </div>

              <div className="dashboard-grid">
                <div className="panel">
                  <h2>Team activity</h2>
                  {activityLog.slice(0, 5).map(entry => (
                    <div key={entry.id} className="recent-task-item">
                      <strong>{entry.action}</strong>
                      <span>{entry.user ? `${entry.user.firstname} ${entry.user.lastName}` : ''}</span>
                    </div>
                  ))}
                  {activityLog.length === 0 && (
                    <EmptyState kind="sparkle" compact title="No activity yet" description="Actions your team takes will show up here in real time." />
                  )}
                </div>
                <div className="panel">
                  <h2>Recent projects</h2>
                  {workspaces.slice(0, 5).map(ws => (
                    <div key={ws.id} className="recent-task-item">
                      <strong>{ws.name}</strong>
                      <span>{ws.description || ''}</span>
                    </div>
                  ))}
                  {workspaces.length === 0 && (
                    <EmptyState kind="workspace" compact title="No projects yet" description="Start your first project and build momentum." />
                  )}
                </div>
              </div>

              {workspacePlan.canUseAnalytics ? (
                <Suspense fallback={<SkeletonChart />}><InsightsPanel /></Suspense>
              ) : (
                <div className="panel full-width">
                  <h2>Smart insights</h2>
                  <EmptyState kind="sparkle" compact title="Unlock smart insights" description="Productive hours, trends, and recommendations become available on a Premium or Team plan." />
                </div>
              )}

              <div className="panel full-width">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Trophy size={16} strokeWidth={1.8} /> Achievements</h2>
                <AchievementsPanel />
              </div>
                </>
              )}
            </>
          )}

          {navPage === 'tasks' && (
            <div className="panel full-width">
              <h2>My Tasks</h2>
              <div className="stack-form stack-form-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="New task title" />
                <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}>
                  <option value="LOW">Low</option><option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option><option value="CRITICAL">Critical</option>
                </select>
                <label className="field-label-inline"><span>Due date</span><input type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)} /></label>
                <label className="field-label-inline"><span>Due time</span><input type="time" value={taskTime} onChange={e => setTaskTime(e.target.value)} /></label>
                <select value={taskAssignedTo} onChange={e => setTaskAssignedTo(e.target.value)}>
                  <option value="">{t('assignTo', settingsLang)}</option>
                  {members.filter(m => m.userId !== user.id).map(m => (
                    <option key={m.userId} value={m.userId}>{m.user.firstname} {m.user.lastName}</option>
                  ))}
                </select>
                <button className="primary-btn" onClick={() => handleCreateTask({ preventDefault: () => {} } as FormEvent<HTMLFormElement>)}>Add</button>
              </div>
              {taskDueDate && (
                <div className="reminder-picker" style={{ marginBottom: 16 }}>
                  <span className="reminder-picker-label">Remind me</span>
                  <div className="reminder-chip-row">
                    {REMINDER_OFFSETS.map(o => (
                      <label key={o.minutes} className={`reminder-chip ${taskReminderOffsets.includes(o.minutes) ? 'active' : ''}`}>
                        <input type="checkbox" checked={taskReminderOffsets.includes(o.minutes)} onChange={() => toggleTaskReminderOffset(o.minutes)} />
                        {o.label}
                      </label>
                    ))}
                  </div>
                  <label className="reminder-custom-row">
                    Custom reminder
                    <input type="datetime-local" value={taskCustomReminderAt} onChange={e => setTaskCustomReminderAt(e.target.value)} />
                  </label>
                </div>
              )}
              {workspacePlan.canUseRecurringTasks && (
                <div style={{ marginBottom: 16 }}>
                  <RecurrencePicker value={taskRecurrence} onChange={setTaskRecurrence} />
                </div>
              )}
              {tasks.length > VIRTUALIZE_THRESHOLD ? (
                <List
                  className="task-list"
                  rowComponent={TaskListRow}
                  rowCount={tasks.length}
                  rowHeight={92}
                  rowProps={{ tasksList: tasks, statusColumns, onSelect: setSelectedTask, onMove: handleMoveTask, onDelete: (t: Task) => handleDeleteTask(t.id), onFocus: openFocusMode }}
                  defaultHeight={640}
                />
              ) : (
                <div className="task-list">
                  {tasks.map(tk => (
                    <TaskListRowStatic key={tk.id} tk={tk} statusColumns={statusColumns} onSelect={setSelectedTask} onMove={handleMoveTask} onDelete={t => handleDeleteTask(t.id)} onFocus={openFocusMode} />
                  ))}
                </div>
              )}
            </div>
          )}

          {navPage === 'boards' && (
            <>
              <div className="panel" style={{ marginBottom: 16 }}>
                <div className="stack-form stack-form-row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Task title" required />
                  <select value={taskPriority} onChange={e => setTaskPriority(e.target.value)}>
                    <option value="LOW">Low</option><option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option><option value="CRITICAL">Critical</option>
                  </select>
                  <label className="field-label-inline"><span>Due date</span><input type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)} /></label>
                  <label className="field-label-inline"><span>Due time</span><input type="time" value={taskTime} onChange={e => setTaskTime(e.target.value)} /></label>
                  <button onClick={() => handleCreateTask({ preventDefault: () => {} } as FormEvent<HTMLFormElement>)}>Add task</button>
                </div>
              </div>
              <div className="kanban-board">
                {statusColumns.map(status => (
                  <div key={status} className="kanban-column">
                    <h3>{status.replace('_', ' ')}</h3>
                    {tasks.filter(tk => tk.status === status).length === 0
                      ? <p className="empty-column">Nothing here yet</p>
                      : tasks.filter(tk => tk.status === status).map(tk => {
                        const blocked = tk.dependsOn?.some(d => d.status !== 'COMPLETED')
                        return (
                          <div key={tk.id} className="task-card" onClick={() => setSelectedTask(tk)} style={{ cursor: 'pointer' }}>
                            <strong>{tk.title}</strong>
                            {tk.description && <p>{tk.description}</p>}
                            <p className="task-meta">Priority: {tk.priority}</p>
                            {tk.dueDate && <p className="task-meta">Due: {new Date(tk.dueDate).toLocaleDateString()}</p>}
                            {(blocked || tk.isRecurring) && (
                              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                                {blocked && <span className="status-badge blocked">Blocked</span>}
                                {tk.isRecurring && <span className="status-badge recurring">Repeats</span>}
                              </div>
                            )}
                            <div className="task-actions" onClick={e => e.stopPropagation()}>
                              <button type="button" className="mini-btn" title="Focus on this task" onClick={() => openFocusMode(tk)}><Maximize2 size={13} /></button>
                              {statusColumns.filter(c => c !== status).map(ns => (
                                <button key={ns} type="button" className="mini-btn" style={{ background: '#1c1f30', color: '#94a3b8' }}
                                  disabled={ns === 'COMPLETED' && blocked}
                                  onClick={() => handleMoveTask(tk.id, ns)}>{ns.replace('_', ' ')}</button>
                              ))}
                              <button type="button" className="mini-btn danger-btn" onClick={() => handleDeleteTask(tk.id)} aria-label={`Delete task ${tk.title}`}><X size={13} /></button>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                ))}
              </div>
            </>
          )}

          {navPage === 'calendar' && (
            <div className="panel full-width">
              <h2>Calendar</h2>
              <Suspense fallback={<SkeletonChart height={480} />}>
                <TaskCalendar tasks={tasks} onTaskClick={id => setSelectedTask(tasks.find(tk => tk.id === id) || null)} />
              </Suspense>
            </div>
          )}

          {navPage === 'workload' && (
            <div className="panel full-width">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Gauge size={16} strokeWidth={1.8} /> {t('workload', settingsLang)}</h2>
              {workspacePlan.canUseAnalytics ? (
                <Suspense fallback={<SkeletonChart />}>
                  <WorkloadCharts workspaceId={selectedWorkspaceId} canSeeTeam={!!canManageMembers || myMembership?.role === 'MANAGER'} currentUserId={user.id} />
                </Suspense>
              ) : (
                <p className="empty-column">Workload visualization requires a Premium or Team plan.</p>
              )}
            </div>
          )}

          {navPage === 'team' && (
            <div className="dashboard-grid">
              <div className="panel">
                <h2>{t('createWorkspace', settingsLang)}</h2>
                <form className="stack-form" onSubmit={handleCreateWorkspace}>
                  <input value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} placeholder={t('workspaceName', settingsLang)} required />
                  <input value={workspaceDescription} onChange={e => setWorkspaceDescription(e.target.value)} placeholder={t('taskDescription', settingsLang)} />
                  <button type="submit">{t('addWorkspace', settingsLang)}</button>
                </form>
              </div>

              <div className="panel">
                <h2>{t('members', settingsLang)} ({members.length})</h2>
                <div className="member-list">
                  {members.map(m => (
                    <div key={m.id} className="member-item">
                      <div className="sidebar-avatar"><AvatarThumb url={m.user.avatarUrl} /></div>
                      <div className="member-info">
                        <strong>{m.user.firstname} {m.user.lastName}</strong>
                        <span>{m.user.email}</span>
                      </div>
                      {canManageMembers && m.role !== 'OWNER' ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <select value={m.role} onChange={e => handleUpdateMemberRole(m.id, e.target.value)} style={{ fontSize: '0.75rem' }}>
                            {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <button type="button" className="mini-btn danger-btn" onClick={() => handleRemoveMember(m.id)} aria-label={`Remove ${m.user.firstname} ${m.user.lastName}`}><X size={13} /></button>
                        </div>
                      ) : (
                        <span className={`role-badge ${m.role.toLowerCase()}`}>{m.role}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><UserPlus size={16} strokeWidth={1.8} />{t('invite', settingsLang)}</h2>
                <form className="stack-form" onSubmit={handleInviteMember}>
                  <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="colleague@company.com" required />
                  <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
                    <option value="MEMBER">Member</option>
                    <option value="MANAGER">Manager</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                  <button type="submit">{t('sendInvite', settingsLang)}</button>
                </form>

                {workspaceInvitations.filter(i => i.status === 'PENDING').length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h3>{t('pendingInvites', settingsLang)}</h3>
                    <div className="invite-list">
                      {workspaceInvitations.filter(i => i.status === 'PENDING').map(inv => (
                        <div key={inv.id} className="invite-item">
                          <span>{inv.email} <span className="role-badge member">{inv.role || 'MEMBER'}</span></span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="mini-btn" onClick={() => handleResendInvitation(inv.id)}>Resend</button>
                            <button type="button" className="mini-btn danger-btn" onClick={() => handleCancelInvitation(inv.id)}>Cancel</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {navPage === 'reports' && (
            <div className="dashboard-grid">
              <div className="panel full-width">
                <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Progress overview {reportsSummary && <span style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 400 }}>(all workspaces)</span>}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="mini-btn secondary-btn" onClick={() => handleExport('tasks', 'csv')}><Download size={13} /> Export tasks CSV</button>
                    <button type="button" className="mini-btn secondary-btn" onClick={() => handleExport('workspaces', 'csv')}><Download size={13} /> Export workspaces CSV</button>
                  </span>
                </h2>
                <StatSummaryCards counts={reportStatusCounts} />
              </div>

              <div className="panel">
                <h2>Completion rate</h2>
                <Suspense fallback={<SkeletonChart />}><StatusDoughnutChart counts={reportStatusCounts} /></Suspense>
              </div>

              <div className="panel">
                <h2>Tasks by status</h2>
                <Suspense fallback={<SkeletonChart />}><StatusBarChart counts={{ ...reportStatusCounts, review: reviewTasks }} /></Suspense>
              </div>

              <div className="panel full-width">
                <h2>Completed this week</h2>
                <Suspense fallback={<SkeletonChart />}><CompletionTrendChart data={trendData} /></Suspense>
              </div>

              <div className="panel full-width">
                <h2>Advanced reporting</h2>
                <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginTop: 0 }}>
                  Generate a productivity report (summary, by team member, by workspace) for this workspace, optionally scoped to a date range.
                </p>
                <div className="stack-form" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ fontSize: '0.78rem', color: '#94a3b8' }}>From
                    <input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)} style={{ marginLeft: 6 }} />
                  </label>
                  <label style={{ fontSize: '0.78rem', color: '#94a3b8' }}>To
                    <input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)} style={{ marginLeft: 6 }} />
                  </label>
                  <button type="button" className="mini-btn secondary-btn" onClick={() => handleExport('report', 'pdf', { from: reportFrom, to: reportTo })}><Download size={13} /> PDF</button>
                  <button type="button" className="mini-btn secondary-btn" onClick={() => handleExport('report', 'xlsx', { from: reportFrom, to: reportTo })}><Download size={13} /> Excel</button>
                  <button type="button" className="mini-btn secondary-btn" onClick={() => handleExport('report', 'csv', { from: reportFrom, to: reportTo })}><Download size={13} /> CSV</button>
                </div>
              </div>
            </div>
          )}

          {navPage === 'activity' && (
            <div className="panel full-width">
              <h2>{t('activity', settingsLang)}</h2>
              <div className="stack-form" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                <label className="audit-search-input">
                  <Search size={14} strokeWidth={1.8} />
                  <input value={activitySearch} onChange={e => setActivitySearch(e.target.value)} placeholder="Search activity…" aria-label="Search activity log" />
                </label>
                <input type="date" value={activityFrom} onChange={e => setActivityFrom(e.target.value)} aria-label="From date" />
                <input type="date" value={activityTo} onChange={e => setActivityTo(e.target.value)} aria-label="To date" />
                {(activitySearch || activityFrom || activityTo) && (
                  <button type="button" className="mini-btn" onClick={() => { setActivitySearch(''); setActivityFrom(''); setActivityTo('') }}>Clear</button>
                )}
              </div>
              {activityLog.length === 0 ? <p className="empty-column">No activity yet</p> : (
                <div className="task-list">
                  {activityLog.map(entry => (
                    <div key={entry.id} className="task-list-item">
                      <div className="task-list-info">
                        <strong>{entry.action}</strong>
                        <span>
                          {entry.user ? `${entry.user.firstname} ${entry.user.lastName}` : ''}
                          {entry.workspace ? ` · ${entry.workspace.name}` : ''}
                          {entry.task ? ` · ${entry.task.title}` : ''}
                        </span>
                      </div>
                      <span className="bar-label">{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {navPage === 'notifications' && (
            <div className="panel full-width">
              <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Notification Center</span>
                {notifCount > 0 && <button type="button" className="mini-btn" onClick={handleMarkAllRead}><CheckCheck size={13} /> Mark all read</button>}
              </h2>
              {notifList.length === 0 ? (
                <EmptyState kind="notifications" title="You're all caught up" description="Task assignments, comments, and due-date reminders will show up here as they happen." />
              ) : (
                <>
                  {(() => {
                    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
                    const today = notifList.filter(n => new Date(n.createdAt) >= startOfToday)
                    const earlier = notifList.filter(n => new Date(n.createdAt) < startOfToday)
                    return (
                      <>
                        {today.length > 0 && (
                          <div className="notif-group">
                            <p className="notif-group-label">Today</p>
                            <div className="notif-card-list">
                              {today.map(n => (
                                <NotificationCard key={n.id} notif={n} onOpenTask={handleOpenNotifTask} onComplete={handleCompleteFromNotif} onMarkRead={handleMarkNotifRead} />
                              ))}
                            </div>
                          </div>
                        )}
                        {earlier.length > 0 && (
                          <div className="notif-group">
                            <p className="notif-group-label">Earlier</p>
                            <div className="notif-card-list">
                              {earlier.map(n => (
                                <NotificationCard key={n.id} notif={n} onOpenTask={handleOpenNotifTask} onComplete={handleCompleteFromNotif} onMarkRead={handleMarkNotifRead} />
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </>
              )}
            </div>
          )}

          {navPage === 'billing' && (
            <Suspense fallback={<SkeletonChart height={320} />}>
              <BillingPanel workspaceId={selectedWorkspaceId} isOwner={myMembership?.role === 'OWNER'} onMessage={showMessage} />
            </Suspense>
          )}

          {navPage === 'settings' && (
            <div className="dashboard-grid">
              <div className="panel">
                <h2>{t('profile', settingsLang)}</h2>
                <form className="stack-form" onSubmit={handleSaveSettings}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 4 }}>
                    <div className="sidebar-avatar" style={{ width: 56, height: 56, borderRadius: 12 }}>
                      <AvatarThumb url={user.avatarUrl} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="mini-btn secondary-btn" onClick={() => avatarFileInputRef.current?.click()} disabled={avatarUploading}>
                          <Upload size={13} /> {avatarUploading ? 'Uploading…' : 'Upload photo'}
                        </button>
                        {user.avatarUrl && (
                          <button type="button" className="mini-btn danger-btn" onClick={handleAvatarRemove}><Trash2 size={13} /> Remove</button>
                        )}
                      </div>
                      <span style={{ color: '#64748b', fontSize: '0.72rem' }}>JPG, PNG, or GIF — up to 5MB.</span>
                      <input ref={avatarFileInputRef} type="file" accept="image/*" onChange={handleAvatarFileChange} style={{ display: 'none' }} />
                    </div>
                  </div>
                  <div className="name-row">
                    <label>First name<input value={settingsName} onChange={e => setSettingsName(e.target.value)} /></label>
                    <label>Last name<input value={settingsLast} onChange={e => setSettingsLast(e.target.value)} /></label>
                  </div>
                  <label style={{ color: '#64748b', fontSize: '0.82rem' }}>Email: {user.email}</label>
                  <button type="submit">{t('saveProfile', settingsLang)}</button>
                </form>
              </div>

              <div className="panel">
                <h2>{t('preferences', settingsLang)}</h2>
                <form className="stack-form" onSubmit={handleSaveSettings}>
                  <label>
                    {t('language', settingsLang)}
                    <select value={settingsLang} onChange={e => handleLanguageChange(e.target.value)}>
                      {Object.entries(LANGUAGES).map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('fontStyle', settingsLang)}
                    <select value={settingsFont} onChange={e => { setSettingsFont(e.target.value); document.documentElement.setAttribute('data-font', e.target.value) }}>
                      {FONTS.map(f => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
                    </select>
                  </label>
                  <label>
                    {t('colorTheme', settingsLang)}
                    <select value={settingsColor} onChange={e => { setSettingsColor(e.target.value); document.documentElement.setAttribute('data-theme', e.target.value) }}>
                      {COLORS.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                    </select>
                  </label>
                  <div className="theme-previews">
                    {COLORS.map(c => (
                      <div key={c} className={`theme-swatch ${settingsColor === c ? 'active' : ''} swatch-${c}`}
                        onClick={() => { setSettingsColor(c); document.documentElement.setAttribute('data-theme', c) }} />
                    ))}
                  </div>
                  <button type="submit">{t('savePrefs', settingsLang)}</button>
                </form>
              </div>

              <div className="panel">
                <h2>Notification preferences</h2>
                <form className="stack-form" onSubmit={handleSaveSettings}>
                  <label className="remember-row">
                    <input type="checkbox" checked={taskNotificationsEnabled} onChange={e => setTaskNotificationsEnabled(e.target.checked)} />
                    <span>Notify me about task assignments and updates</span>
                  </label>
                  <label className="remember-row">
                    <input type="checkbox" checked={emailNotificationsEnabled} onChange={e => setEmailNotificationsEnabled(e.target.checked)} />
                    <span>Send me workspace invitation emails</span>
                  </label>
                  <button type="submit">Save notification settings</button>
                </form>
              </div>

              <div className="panel">
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><BellRing size={16} strokeWidth={1.8} /> Push notifications</h2>
                {!isPushSupported() ? (
                  <p className="empty-column">Push notifications aren't supported in this browser.</p>
                ) : (
                  <form className="stack-form" onSubmit={handleSaveNotifPrefs}>
                    <label className="remember-row">
                      <input type="checkbox" checked={notifPrefs.pushEnabled} onChange={e => handleTogglePush(e.target.checked)} />
                      <span>Enable push notifications (works even when Taskly is closed)</span>
                    </label>
                    {pushPermission === 'denied' && (
                      <p style={{ color: '#f87171', fontSize: '0.78rem', margin: 0 }}>Notifications are blocked for this site in your browser settings — enable them there first.</p>
                    )}
                    <label className="remember-row">
                      <input type="checkbox" checked={notifPrefs.soundEnabled} onChange={e => setNotifPrefs(p => ({ ...p, soundEnabled: e.target.checked }))} />
                      <span><Volume2 size={13} style={{ verticalAlign: -2 }} /> Play a sound</span>
                    </label>
                    <label className="remember-row">
                      <input type="checkbox" checked={notifPrefs.vibrationEnabled} onChange={e => setNotifPrefs(p => ({ ...p, vibrationEnabled: e.target.checked }))} />
                      <span><Vibrate size={13} style={{ verticalAlign: -2 }} /> Vibrate (supported devices)</span>
                    </label>
                    <div>
                      <span style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: 6 }}>Default reminder times for new tasks</span>
                      <div className="reminder-chip-row">
                        {REMINDER_OFFSETS.map(o => (
                          <label key={o.minutes} className={`reminder-chip ${notifPrefs.defaultReminderMinutes.includes(o.minutes) ? 'active' : ''}`}>
                            <input type="checkbox" checked={notifPrefs.defaultReminderMinutes.includes(o.minutes)} onChange={() => toggleDefaultReminderMinute(o.minutes)} />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="submit">Save notification settings</button>
                      <button type="button" className="mini-btn secondary-btn" onClick={handleSendTestPush} disabled={!notifPrefs.pushEnabled}>Send test notification</button>
                    </div>
                  </form>
                )}
              </div>

              <div className="panel">
                <h2>Change password</h2>
                <form className="stack-form" onSubmit={handleChangePassword}>
                  <input type="password" required placeholder="Current password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
                  <input type="password" required minLength={8} placeholder="New password (min 8 characters)" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
                  <button type="submit">Update password</button>
                </form>
              </div>

              <div className="panel full-width">
                <h2>Active sessions</h2>
                <div className="task-list">
                  {sessions.map(s => (
                    <div key={s.id} className="task-list-item">
                      <div className="task-list-info">
                        <strong>{s.userAgent || 'Unknown device'} {s.isCurrent && <span className="role-badge member">This device</span>}</strong>
                        <span>{s.ipAddress || ''} · Last active {new Date(s.lastUsedAt).toLocaleString()}</span>
                      </div>
                      {!s.isCurrent && (
                        <button type="button" className="mini-btn danger-btn" onClick={() => handleRevokeSession(s.id)}>Revoke</button>
                      )}
                    </div>
                  ))}
                  {sessions.length === 0 && <p className="empty-column">No active sessions</p>}
                </div>
                <button type="button" className="mini-btn danger-btn" style={{ marginTop: 12 }} onClick={handleLogoutAllDevices}>Log out of all devices</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedTask && (
        <Modal title={selectedTask.title} onClose={() => setSelectedTask(null)}>
          {selectedTask.description && <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginTop: 0 }}>{selectedTask.description}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span className={`priority-badge ${selectedTask.priority.toLowerCase()}`}>{selectedTask.priority}</span>
            <span className={`status-badge ${selectedTask.status.toLowerCase()}`}>{selectedTask.status.replace('_', ' ')}</span>
          </div>
          {selectedTask.dueDate && <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Due {new Date(selectedTask.dueDate).toLocaleString()}</p>}
          {selectedTask.dependsOn?.some(d => d.status !== 'COMPLETED') && (
            <p style={{ fontSize: '0.8rem', color: '#f87171' }}>Blocked by {selectedTask.dependsOn.filter(d => d.status !== 'COMPLETED').map(d => d.title).join(', ')}</p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <select
              value={selectedTask.status}
              disabled={selectedTask.dependsOn?.some(d => d.status !== 'COMPLETED')}
              onChange={e => { handleMoveTask(selectedTask.id, e.target.value); setSelectedTask({ ...selectedTask, status: e.target.value }) }}
            >
              {statusColumns.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
            <button type="button" className="mini-btn" onClick={() => openFocusMode(selectedTask)}><Maximize2 size={13} /> Focus mode</button>
            <button type="button" className="mini-btn danger-btn" onClick={() => { handleDeleteTask(selectedTask.id); setSelectedTask(null) }}>Delete task</button>
          </div>
          <TaskDetailPanel
            taskId={selectedTask.id}
            workspaceId={selectedTask.workspaceId}
            currentUserId={user.id}
            canModerate={!!canManageMembers || myMembership?.role === 'MANAGER'}
            onMessage={showMessage}
            dueDate={selectedTask.dueDate}
            assignedToId={selectedTask.assignedToId}
            dependsOn={selectedTask.dependsOn || []}
            blocks={selectedTask.blocks || []}
            workspaceTasks={tasks.map(tk => ({ id: tk.id, title: tk.title, status: tk.status }))}
            recurrence={taskToRecurrence(selectedTask)}
            canUseDependencies={workspacePlan.canUseDependencies}
            canUseRecurringTasks={workspacePlan.canUseRecurringTasks}
            onTaskUpdated={() => { loadTasks(); }}
          />
        </Modal>
      )}
    </main>
  )
}
