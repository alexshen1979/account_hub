import { lazy, Suspense, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Boxes,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  ClipboardList,
  Copy,
  CreditCard,
  Cpu,
  HardDrive,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListRestart,
  LogOut,
  Menu,
  MemoryStick,
  Package,
  Plus,
  Power,
  ReceiptText,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { ApiError, api, formatCredits, formatMoney, formatTime, post } from "./api";
import type { ServerMetricPoint } from "./ServerChart";

const ServerChart = lazy(() => import("./ServerChart"));

type Page = "overview" | "applications" | "users" | "plans" | "payments" | "orders" | "ledger" | "audit";
interface Me { user: { id: string; email: string; displayName: string; systemRole: string } }
interface Application { id: string; name: string; slug: string; status: string; redirect_uris: string; allow_registration: boolean; created_at: string; user_count: string; active_key_count: string }
interface Overview {
  applications: number;
  users: number;
  availableCredits: number;
  frozenCredits: number;
  paidOrders: number;
  revenueCents: number;
}
interface ServerStatus {
  state: "healthy" | "warning" | "critical" | "unknown";
  sampledAt: string;
  hostname: string;
  platform: string;
  distro: string;
  release: string;
  arch: string;
  nodeVersion: string;
  hostUptimeSeconds: number;
  serviceUptimeSeconds: number;
  cpu: { usagePercent: number; cores: number; model: string };
  memory: { totalBytes: number; usedBytes: number; usagePercent: number };
  disk: { totalBytes: number; usedBytes: number; usagePercent: number; mount: string };
}
interface User { id: string; email: string; display_name: string; status: string; created_at: string; application_id: string; wallet_id: string; available: string; frozen: string }
interface Plan { id: string; application_id: string; name: string; code: string; price_cents: number; currency: string; included_credits: string; validity_days: number; status: string; created_at: string }
interface Order { id: string; order_no: string; application_id: string; display_name: string; email: string; plan_name: string; provider: string; amount_cents: number; currency: string; credits: string; status: string; created_at: string }
interface PaymentProvider { id: string; application_id: string; provider: string; name: string; status: string; config: { gatewayUrl?: string; merchantIdMasked?: string; paymentType?: "alipay" | "wxpay" }; created_at: string; updated_at: string }
interface LedgerItem { id: string; type: string; display_name: string; email: string; wallet_delta: string; balance_check: string; note: string | null; created_at: string }
interface AuditItem { id: string; action: string; actor_email: string; target_type: string; target_id: string; created_at: string }

const navItems: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "总览", icon: LayoutDashboard },
  { id: "applications", label: "应用", icon: Boxes },
  { id: "users", label: "用户", icon: Users },
  { id: "plans", label: "套餐", icon: Package },
  { id: "payments", label: "支付渠道", icon: Landmark },
  { id: "orders", label: "订单", icon: ReceiptText },
  { id: "ledger", label: "账本", icon: ListRestart },
  { id: "audit", label: "审计", icon: ClipboardList },
];

const titles: Record<Page, { title: string; subtitle: string }> = {
  overview: { title: "业务总览", subtitle: "账户与计费运行状态" },
  applications: { title: "应用管理", subtitle: "接入 Account Hub 的业务网站" },
  users: { title: "用户管理", subtitle: "账号状态与额度余额" },
  plans: { title: "套餐管理", subtitle: "充值价格与到账额度" },
  payments: { title: "支付渠道", subtitle: "收银台配置与回调验签" },
  orders: { title: "充值订单", subtitle: "支付状态和到账记录" },
  ledger: { title: "额度账本", subtitle: "不可变交易及平衡校验" },
  audit: { title: "操作审计", subtitle: "管理员关键操作记录" },
};

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Empty({ label }: { label: string }) {
  return <div className="empty"><AppWindow size={30} /><span>{label}</span></div>;
}

function Status({ value }: { value: string }) {
  const labels: Record<string, string> = { active: "启用", disabled: "停用", paid: "已支付", pending: "待支付", cancelled: "已取消", refunded: "已退款" };
  return <span className={`status status-${value}`}>{labels[value] ?? value}</span>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("admin@local.test");
  const [password, setPassword] = useState("Admin123!");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await post("/api/v1/auth/login", { email, password });
      onLogin();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark"><ShieldCheck size={25} /></div>
        <div className="login-heading"><p>ACCOUNT HUB</p><h1>管理后台</h1></div>
        <form onSubmit={submit}>
          <Field label="管理员邮箱"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></Field>
          <Field label="密码"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></Field>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button login-button" disabled={loading}>{loading ? <RefreshCw className="spin" size={17} /> : <KeyRound size={17} />}登录</button>
        </form>
      </section>
    </main>
  );
}

function formatBytes(value: number): string {
  if (!value) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function OverviewView({ data, server, history }: { data: Overview | null; server: ServerStatus | null; history: ServerMetricPoint[] }) {
  if (!data) return <div className="loading-line" />;
  const metrics = [
    { label: "启用应用", value: data.applications, icon: Boxes, tone: "green" },
    { label: "业务用户", value: data.users, icon: Users, tone: "blue" },
    { label: "可用额度", value: formatCredits(data.availableCredits), icon: WalletCards, tone: "amber" },
    { label: "累计实收", value: formatMoney(data.revenueCents), icon: CircleDollarSign, tone: "red" },
  ];
  const stateLabels = { healthy: "运行正常", warning: "负载偏高", critical: "资源紧张", unknown: "状态未知" };
  const resources = server ? [
    { label: "CPU 使用率", value: `${server.cpu.usagePercent.toFixed(1)}%`, percent: server.cpu.usagePercent, detail: `${server.cpu.cores || "-"} 个逻辑核心`, icon: Cpu },
    { label: "内存使用", value: `${server.memory.usagePercent.toFixed(1)}%`, percent: server.memory.usagePercent, detail: `${formatBytes(server.memory.usedBytes)} / ${formatBytes(server.memory.totalBytes)}`, icon: MemoryStick },
    { label: "服务磁盘", value: `${server.disk.usagePercent.toFixed(1)}%`, percent: server.disk.usagePercent, detail: `${formatBytes(server.disk.usedBytes)} / ${formatBytes(server.disk.totalBytes)} · ${server.disk.mount}`, icon: HardDrive },
    { label: "系统运行时间", value: formatDuration(server.hostUptimeSeconds), percent: null, detail: `服务进程 ${formatDuration(server.serviceUptimeSeconds)}`, icon: Clock3 },
  ] : [];
  return (
    <>
      <div className="metric-grid">
        {metrics.map((metric) => <article className="metric" key={metric.label}><div className={`metric-icon ${metric.tone}`}><metric.icon size={20} /></div><div><span>{metric.label}</span><strong>{metric.value}</strong></div></article>)}
      </div>
      <section className="summary-band">
        <div><span>冻结额度</span><strong>{formatCredits(data.frozenCredits)}</strong></div>
        <div><span>成功订单</span><strong>{data.paidOrders.toLocaleString("zh-CN")}</strong></div>
        <div><span>账本模式</span><strong className="verified"><Check size={16} />双边平衡</strong></div>
      </section>
      {server ? <section className="server-panel">
        <div className="server-panel-header"><div className="server-heading"><span className="server-icon"><Server size={19} /></span><div><h2>服务器状态</h2><p>{server.hostname} · {server.platform}</p></div></div><span className={`server-state ${server.state}`}><i />{stateLabels[server.state]}</span></div>
        <div className="server-resource-grid">{resources.map((resource) => <div className="server-resource" key={resource.label}><div className="resource-label"><resource.icon size={16} /><span>{resource.label}</span></div><strong>{resource.value}</strong>{resource.percent !== null && <div className="resource-bar" aria-label={`${resource.label} ${resource.value}`}><span className={resource.percent >= 90 ? "high" : resource.percent >= 75 ? "medium" : ""} style={{ width: `${resource.percent}%` }} /></div>}<small>{resource.detail}</small></div>)}</div>
        <div className="server-chart-section">
          <div className="server-chart-header"><div><h3>实时资源曲线</h3><p>15 秒刷新 · 最近 40 个数据点</p></div><div className="chart-legend" aria-label="曲线图例"><span className="cpu"><i />CPU</span><span className="memory"><i />内存</span><span className="disk"><i />磁盘</span></div></div>
          <div className="server-chart" role="img" aria-label="CPU、内存和磁盘使用率实时曲线">
            {history.length < 2 ? <div className="server-chart-empty"><RefreshCw className="spin" size={17} /><span>正在积累实时采样数据</span></div> : <Suspense fallback={<div className="server-chart-empty"><RefreshCw className="spin" size={17} /></div>}><ServerChart data={history} /></Suspense>}
          </div>
        </div>
        <div className="server-meta"><span title={`${server.distro} ${server.release}`}>系统：{server.distro} {server.release} · {server.arch}</span><span title={server.cpu.model}>处理器：{server.cpu.model || "未知"}</span><span>运行时：Node {server.nodeVersion}</span><span>采样：{formatTime(server.sampledAt)}</span></div>
      </section> : <section className="server-panel server-loading"><RefreshCw className="spin" size={18} /><span>正在读取服务器状态</span></section>}
    </>
  );
}

function ApplicationsView({ applications, reload, notify }: { applications: Application[]; reload: () => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [redirectText, setRedirectText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState<Application | null>(null);
  const [editRedirectText, setEditRedirectText] = useState("");
  const [allowRegistration, setAllowRegistration] = useState(true);
  function parseRedirects(value: string) {
    return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await post<{ apiKey: string }>("/api/v1/admin/applications", { name, slug, redirectUris: parseRedirects(redirectText) });
      setApiKey(result.apiKey);
      reload();
    } catch (error) { notify(error instanceof Error ? error.message : "创建失败"); }
  }
  async function createKey(application: Application) {
    try {
      const result = await post<{ apiKey: string }>(`/api/v1/admin/applications/${application.id}/keys`);
      setApiKey(result.apiKey);
      setOpen(true);
      reload();
    } catch (error) { notify(error instanceof Error ? error.message : "密钥创建失败"); }
  }
  function copyPortalUrl(application: Application) {
    const url = `${window.location.origin}/portal?app=${encodeURIComponent(application.slug)}`;
    navigator.clipboard.writeText(url);
    notify("用户入口地址已复制");
  }
  function openSettings(application: Application) {
    let current: string[] = [];
    try { current = JSON.parse(application.redirect_uris); } catch { /* empty configuration */ }
    setEditing(application);
    setEditRedirectText(current.join("\n"));
    setAllowRegistration(application.allow_registration);
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try {
      await api(`/api/v1/admin/applications/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ redirectUris: parseRedirects(editRedirectText), allowRegistration }),
      });
      setEditing(null);
      reload();
      notify("应用接入配置已保存");
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
  }
  return (
    <>
      <div className="action-row"><div /><button className="primary-button" onClick={() => setOpen(true)}><Plus size={17} />新建应用</button></div>
      <div className="table-wrap"><table><thead><tr><th>应用</th><th>标识</th><th>用户</th><th>有效密钥</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>
        {applications.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td><code>{item.slug}</code></td><td>{item.user_count}</td><td>{item.active_key_count}</td><td><Status value={item.status} /></td><td>{formatTime(item.created_at)}</td><td className="align-right app-actions"><button className="icon-button bordered" title="复制用户入口" onClick={() => copyPortalUrl(item)}><Copy size={15} /></button><button className="icon-button bordered" title="接入设置" onClick={() => openSettings(item)}><Settings size={15} /></button><button className="icon-button bordered" title="创建应用密钥" onClick={() => createKey(item)}><KeyRound size={15} /></button></td></tr>)}
      </tbody></table>{applications.length === 0 && <Empty label="暂无应用" />}</div>
      {open && <Modal title={apiKey ? "应用已创建" : "新建应用"} onClose={() => { setOpen(false); setApiKey(""); }}>
        {apiKey ? <div className="modal-body"><p className="key-warning">应用密钥只显示这一次</p><div className="secret-row"><code>{apiKey}</code><button className="icon-button" title="复制" onClick={() => { navigator.clipboard.writeText(apiKey); notify("密钥已复制"); }}><Copy size={17} /></button></div><button className="primary-button full-button" onClick={() => { setOpen(false); setApiKey(""); }}>完成</button></div> :
          <form className="modal-body" onSubmit={submit}><Field label="应用名称"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field><Field label="应用标识"><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="example-app" required /></Field><Field label="登录回调地址"><textarea rows={3} value={redirectText} onChange={(e) => setRedirectText(e.target.value)} placeholder="https://app.example.com/api/auth/callback" /></Field><button className="primary-button full-button"><Plus size={17} />创建应用</button></form>}
      </Modal>}
      {editing && <Modal title={`${editing.name} · 接入设置`} onClose={() => setEditing(null)}><form className="modal-body" onSubmit={saveSettings}><Field label="登录回调地址"><textarea rows={4} value={editRedirectText} onChange={(e) => setEditRedirectText(e.target.value)} placeholder="每行一个完整地址" /></Field><label className="switch-row"><div><strong>允许自主注册</strong><span>新用户授权时自动加入该应用</span></div><input type="checkbox" checked={allowRegistration} onChange={(e) => setAllowRegistration(e.target.checked)} role="switch" /></label><button className="primary-button full-button"><Settings size={17} />保存接入设置</button></form></Modal>}
    </>
  );
}

function UsersView({ users, applications, appId, reload, notify }: { users: User[]; applications: Application[]; appId: string; reload: () => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [adjusting, setAdjusting] = useState<User | null>(null);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ displayName: "", email: "", password: "", initialCredits: 0 });
  const [delta, setDelta] = useState(0);
  const [note, setNote] = useState("");
  const visible = users.filter((user) => `${user.display_name}${user.email}`.toLowerCase().includes(query.toLowerCase()));
  async function createUser(event: FormEvent) {
    event.preventDefault();
    try { await post("/api/v1/admin/users", { ...form, applicationId: appId }); setOpen(false); setForm({ displayName: "", email: "", password: "", initialCredits: 0 }); reload(); notify("用户已创建"); }
    catch (error) { notify(error instanceof Error ? error.message : "创建失败"); }
  }
  async function adjust(event: FormEvent) {
    event.preventDefault();
    if (!adjusting) return;
    try { await post(`/api/v1/admin/wallets/${adjusting.wallet_id}/adjust`, { delta, note }); setAdjusting(null); setDelta(0); setNote(""); reload(); notify("额度已调整"); }
    catch (error) { notify(error instanceof Error ? error.message : "调整失败"); }
  }
  return (
    <>
      <div className="action-row"><div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索用户" /></div><button className="primary-button" onClick={() => setOpen(true)} disabled={!appId}><UserPlus size={17} />新增用户</button></div>
      <div className="table-wrap"><table><thead><tr><th>用户</th><th>可用额度</th><th>冻结</th><th>状态</th><th>注册时间</th><th></th></tr></thead><tbody>
        {visible.map((user) => <tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.email}</small></td><td className="number-cell">{formatCredits(user.available)}</td><td>{formatCredits(user.frozen)}</td><td><Status value={user.status} /></td><td>{formatTime(user.created_at)}</td><td className="align-right"><button className="secondary-button compact" onClick={() => setAdjusting(user)}><WalletCards size={15} />调额</button></td></tr>)}
      </tbody></table>{visible.length === 0 && <Empty label="暂无用户" />}</div>
      {open && <Modal title="新增用户" onClose={() => setOpen(false)}><form className="modal-body" onSubmit={createUser}><Field label="显示名称"><input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></Field><Field label="邮箱"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field><Field label="初始密码"><input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></Field><Field label="开户额度"><input type="number" min={0} value={form.initialCredits} onChange={(e) => setForm({ ...form, initialCredits: Number(e.target.value) })} /></Field><button className="primary-button full-button"><UserPlus size={17} />创建用户</button></form></Modal>}
      {adjusting && <Modal title={`调整 ${adjusting.display_name} 的额度`} onClose={() => setAdjusting(null)}><form className="modal-body" onSubmit={adjust}><Field label="变动额度"><input type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} required /></Field><Field label="变动原因"><input value={note} onChange={(e) => setNote(e.target.value)} required /></Field><button className="primary-button full-button"><WalletCards size={17} />确认入账</button></form></Modal>}
    </>
  );
}

function PlansView({ plans, appId, reload, notify }: { plans: Plan[]; appId: string; reload: () => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", priceYuan: 9.9, includedCredits: 1000, validityDays: 0 });
  async function submit(event: FormEvent) {
    event.preventDefault();
    try { await post("/api/v1/admin/plans", { applicationId: appId, name: form.name, code: form.code, priceCents: Math.round(form.priceYuan * 100), currency: "CNY", includedCredits: form.includedCredits, validityDays: form.validityDays }); setOpen(false); reload(); notify("套餐已创建"); }
    catch (error) { notify(error instanceof Error ? error.message : "创建失败"); }
  }
  return (
    <>
      <div className="action-row"><div /><button className="primary-button" onClick={() => setOpen(true)} disabled={!appId}><Plus size={17} />新建套餐</button></div>
      <div className="plan-grid">{plans.map((plan) => <article className="plan-item" key={plan.id}><div className="plan-head"><div><span>{plan.code}</span><h3>{plan.name}</h3></div><Status value={plan.status} /></div><strong className="plan-price">{formatMoney(plan.price_cents, plan.currency)}</strong><div className="plan-meta"><span>{formatCredits(plan.included_credits)} 额度</span><span>{plan.validity_days === 0 ? "长期有效" : `${plan.validity_days} 天`}</span></div></article>)}</div>
      {plans.length === 0 && <Empty label="暂无套餐" />}
      {open && <Modal title="新建套餐" onClose={() => setOpen(false)}><form className="modal-body" onSubmit={submit}><Field label="套餐名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field><Field label="套餐代码"><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="starter" required /></Field><div className="field-grid"><Field label="售价（元）"><input type="number" min={0} step="0.01" value={form.priceYuan} onChange={(e) => setForm({ ...form, priceYuan: Number(e.target.value) })} /></Field><Field label="到账额度"><input type="number" min={1} value={form.includedCredits} onChange={(e) => setForm({ ...form, includedCredits: Number(e.target.value) })} /></Field></div><Field label="有效天数（0 为长期）"><input type="number" min={0} value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: Number(e.target.value) })} /></Field><button className="primary-button full-button"><Package size={17} />创建套餐</button></form></Modal>}
    </>
  );
}

function PaymentsView({ providers, appId, reload, notify }: { providers: PaymentProvider[]; appId: string; reload: () => void; notify: (message: string) => void }) {
  const emptyForm = { name: "易支付", gatewayUrl: "", merchantId: "", merchantKey: "", paymentType: "alipay" as const, status: "active" as const };
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentProvider | null>(null);
  const [form, setForm] = useState<{ name: string; gatewayUrl: string; merchantId: string; merchantKey: string; paymentType: "alipay" | "wxpay"; status: "active" | "disabled" }>(emptyForm);
  const notifyUrl = `${window.location.origin}/api/v1/payments/epay/notify`;

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function startEdit(provider: PaymentProvider) {
    setEditing(provider);
    setForm({
      name: provider.name,
      gatewayUrl: provider.config.gatewayUrl ?? "",
      merchantId: "",
      merchantKey: "",
      paymentType: provider.config.paymentType ?? "alipay",
      status: provider.status === "active" ? "active" : "disabled",
    });
    setOpen(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      if (editing) {
        const payload: Record<string, string> = {
          name: form.name,
          gatewayUrl: form.gatewayUrl,
          paymentType: form.paymentType,
          status: form.status,
        };
        if (form.merchantId) payload.merchantId = form.merchantId;
        if (form.merchantKey) payload.merchantKey = form.merchantKey;
        await api(`/api/v1/admin/payment-providers/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await post("/api/v1/admin/payment-providers", { ...form, applicationId: appId });
      }
      setOpen(false);
      reload();
      notify(editing ? "支付渠道已更新" : "支付渠道已创建");
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
  }

  async function toggle(provider: PaymentProvider) {
    try {
      await api(`/api/v1/admin/payment-providers/${provider.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: provider.status === "active" ? "disabled" : "active" }),
      });
      reload();
      notify(provider.status === "active" ? "支付渠道已停用" : "支付渠道已启用");
    } catch (error) { notify(error instanceof Error ? error.message : "操作失败"); }
  }

  return (
    <>
      <div className="action-row"><div className="callback-address"><span>异步通知地址</span><code>{notifyUrl}</code><button className="icon-button bordered" title="复制异步通知地址" onClick={() => { navigator.clipboard.writeText(notifyUrl); notify("异步通知地址已复制"); }}><Copy size={15} /></button></div><button className="primary-button" onClick={startCreate} disabled={!appId}><Plus size={17} />新建渠道</button></div>
      <div className="table-wrap"><table><thead><tr><th>渠道</th><th>协议</th><th>收款方式</th><th>商户号</th><th>网关</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>
        {providers.map((provider) => <tr key={provider.id}><td><strong>{provider.name}</strong></td><td><code>易支付 MD5</code></td><td>{provider.config.paymentType === "wxpay" ? "微信支付" : "支付宝"}</td><td><code>{provider.config.merchantIdMasked || "-"}</code></td><td className="url-cell" title={provider.config.gatewayUrl}>{provider.config.gatewayUrl || "-"}</td><td><Status value={provider.status} /></td><td>{formatTime(provider.updated_at)}</td><td className="align-right app-actions"><button className="icon-button bordered" title="编辑渠道" onClick={() => startEdit(provider)}><Settings size={15} /></button><button className="icon-button bordered" title={provider.status === "active" ? "停用渠道" : "启用渠道"} onClick={() => toggle(provider)}><Power size={15} /></button></td></tr>)}
      </tbody></table>{providers.length === 0 && <Empty label="暂无支付渠道" />}</div>
      {open && <Modal title={editing ? "编辑支付渠道" : "新建支付渠道"} onClose={() => setOpen(false)}><form className="modal-body" onSubmit={save}>
        <Field label="渠道名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="易支付网关地址"><input type="url" value={form.gatewayUrl} onChange={(e) => setForm({ ...form, gatewayUrl: e.target.value })} placeholder="https://pay.example.com" required /></Field>
        <Field label={editing ? `商户号（当前 ${editing.config.merchantIdMasked || "已配置"}）` : "商户号"}><input value={form.merchantId} onChange={(e) => setForm({ ...form, merchantId: e.target.value })} required={!editing} placeholder={editing ? "留空则不修改" : ""} /></Field>
        <Field label="商户密钥"><input type="password" value={form.merchantKey} onChange={(e) => setForm({ ...form, merchantKey: e.target.value })} required={!editing} placeholder={editing ? "留空则不修改" : ""} autoComplete="new-password" /></Field>
        <div className="field-grid"><Field label="收款方式"><select value={form.paymentType} onChange={(e) => setForm({ ...form, paymentType: e.target.value as "alipay" | "wxpay" })}><option value="alipay">支付宝</option><option value="wxpay">微信支付</option></select></Field><Field label="状态"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "disabled" })}><option value="active">启用</option><option value="disabled">停用</option></select></Field></div>
        <p className="key-warning">商户密钥加密保存，保存后不会再次显示。</p>
        <button className="primary-button full-button"><Landmark size={17} />保存支付渠道</button>
      </form></Modal>}
    </>
  );
}

function OrdersView({ orders, users, plans, appId, reload, notify }: { orders: Order[]; users: User[]; plans: Plan[]; appId: string; reload: () => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [planId, setPlanId] = useState("");
  async function createOrder(event: FormEvent) {
    event.preventDefault();
    try { await post("/api/v1/admin/orders", { applicationId: appId, userId, planId }); setOpen(false); reload(); notify("模拟订单已创建"); }
    catch (error) { notify(error instanceof Error ? error.message : "创建失败"); }
  }
  async function pay(id: string) {
    try { await post(`/api/v1/admin/orders/${id}/mock-pay`); reload(); notify("支付回调已处理，额度已到账"); }
    catch (error) { notify(error instanceof Error ? error.message : "支付失败"); }
  }
  return (
    <>
      <div className="action-row"><div /><button className="primary-button" onClick={() => setOpen(true)} disabled={!users.length || !plans.length}><Plus size={17} />模拟充值</button></div>
      <div className="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>额度</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>
        {orders.map((order) => <tr key={order.id}><td><code>{order.order_no}</code></td><td><strong>{order.display_name}</strong><small>{order.email}</small></td><td>{order.plan_name}</td><td>{formatMoney(order.amount_cents, order.currency)}</td><td>{formatCredits(order.credits)}</td><td><Status value={order.status} /></td><td>{formatTime(order.created_at)}</td><td className="align-right">{order.status === "pending" && <button className="secondary-button compact" onClick={() => pay(order.id)}><CreditCard size={15} />确认支付</button>}</td></tr>)}
      </tbody></table>{orders.length === 0 && <Empty label="暂无订单" />}</div>
      {open && <Modal title="模拟充值" onClose={() => setOpen(false)}><form className="modal-body" onSubmit={createOrder}><Field label="用户"><select value={userId} onChange={(e) => setUserId(e.target.value)} required><option value="">请选择</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.email}</option>)}</select></Field><Field label="套餐"><select value={planId} onChange={(e) => setPlanId(e.target.value)} required><option value="">请选择</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatMoney(p.price_cents, p.currency)}</option>)}</select></Field><button className="primary-button full-button"><CreditCard size={17} />创建待支付订单</button></form></Modal>}
    </>
  );
}

function LedgerView({ items }: { items: LedgerItem[] }) {
  const labels: Record<string, string> = { credit: "入账", debit: "扣减", reserve: "冻结", capture: "结算", release: "释放" };
  return <div className="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>类型</th><th>用户侧变动</th><th>平衡校验</th><th>备注</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{formatTime(item.created_at)}</td><td><strong>{item.display_name || "系统"}</strong><small>{item.email}</small></td><td><span className="ledger-type">{labels[item.type] ?? item.type}</span></td><td className={Number(item.wallet_delta) >= 0 ? "positive" : "negative"}>{Number(item.wallet_delta) > 0 ? "+" : ""}{formatCredits(item.wallet_delta)}</td><td><span className={Number(item.balance_check) === 0 ? "check-ok" : "check-fail"}>{Number(item.balance_check) === 0 ? <><Check size={14} />0</> : item.balance_check}</span></td><td>{item.note || "-"}</td></tr>)}</tbody></table>{items.length === 0 && <Empty label="暂无账本记录" />}</div>;
}

function AuditView({ items }: { items: AuditItem[] }) {
  return <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>对象 ID</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{formatTime(item.created_at)}</td><td>{item.actor_email || "系统"}</td><td><code>{item.action}</code></td><td>{item.target_type}</td><td><code className="muted-code">{item.target_id.slice(0, 14)}</code></td></tr>)}</tbody></table>{items.length === 0 && <Empty label="暂无审计记录" />}</div>;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [page, setPage] = useState<Page>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [applications, setApplications] = useState<Application[]>([]);
  const [appId, setAppId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverHistory, setServerHistory] = useState<ServerMetricPoint[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [auditItems, setAuditItems] = useState<AuditItem[]>([]);
  const [toast, setToast] = useState("");

  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3200); }, []);
  const checkAuth = useCallback(async () => {
    try { const data = await api<Me>("/api/v1/auth/me"); if (data.user.systemRole !== "admin") throw new Error("需要管理员权限"); setMe(data); }
    catch { setMe(null); }
    finally { setAuthChecked(true); }
  }, []);

  const loadApplications = useCallback(async () => {
    const data = await api<Application[]>("/api/v1/admin/applications");
    setApplications(data);
    setAppId((current) => current && data.some((item) => item.id === current) ? current : data[0]?.id ?? "");
  }, []);
  const loadOverview = useCallback(async () => setOverview(await api<Overview>("/api/v1/admin/overview")), []);
  const loadServerStatus = useCallback(async () => {
    const nextStatus = await api<ServerStatus>("/api/v1/admin/server-status");
    setServerStatus(nextStatus);
    setServerHistory((current) => {
      if (current.some((point) => point.sampledAt === nextStatus.sampledAt)) return current;
      return [...current, {
        sampledAt: nextStatus.sampledAt,
        cpu: nextStatus.cpu.usagePercent,
        memory: nextStatus.memory.usagePercent,
        disk: nextStatus.disk.usagePercent,
      }].slice(-40);
    });
  }, []);
  const loadScoped = useCallback(async () => {
    if (!appId) { setUsers([]); setPlans([]); setProviders([]); setOrders([]); setLedger([]); return; }
    const query = `?applicationId=${encodeURIComponent(appId)}`;
    const [nextUsers, nextPlans, nextProviders, nextOrders, nextLedger] = await Promise.all([
      api<User[]>(`/api/v1/admin/users${query}`), api<Plan[]>(`/api/v1/admin/plans${query}`), api<PaymentProvider[]>(`/api/v1/admin/payment-providers${query}`), api<Order[]>(`/api/v1/admin/orders${query}`), api<LedgerItem[]>(`/api/v1/admin/ledger${query}`),
    ]);
    setUsers(nextUsers); setPlans(nextPlans); setProviders(nextProviders); setOrders(nextOrders); setLedger(nextLedger);
  }, [appId]);
  const loadAudit = useCallback(async () => setAuditItems(await api<AuditItem[]>("/api/v1/admin/audit-logs")), []);

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => { if (me) Promise.all([loadApplications(), loadOverview(), loadAudit()]).catch((e) => notify(e.message)); }, [me, loadApplications, loadOverview, loadAudit, notify]);
  useEffect(() => {
    if (!me) return;
    loadServerStatus().catch((e) => notify(e.message));
    const timer = window.setInterval(() => { loadServerStatus().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(timer);
  }, [me, loadServerStatus, notify]);
  useEffect(() => { if (me && appId) loadScoped().catch((e) => notify(e.message)); }, [me, appId, loadScoped, notify]);

  const selectedApp = useMemo(() => applications.find((item) => item.id === appId), [applications, appId]);
  async function logout() { await post("/api/v1/auth/logout"); setMe(null); setServerStatus(null); setServerHistory([]); }
  function reloadAll() { loadOverview(); loadServerStatus(); loadApplications(); loadScoped(); loadAudit(); }

  if (!authChecked) return <div className="boot-screen"><div className="brand-mark"><ShieldCheck size={24} /></div></div>;
  if (!me) return <Login onLogin={checkAuth} />;

  return (
    <div className="app-shell">
      <aside className={mobileNav ? "sidebar mobile-open" : "sidebar"}>
        <div className="brand"><div className="brand-mark small"><ShieldCheck size={20} /></div><div><strong>Account Hub</strong><span>CONTROL CENTER</span></div><button className="icon-button nav-close" onClick={() => setMobileNav(false)}><X size={19} /></button></div>
        <nav>{navItems.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => { setPage(item.id); setMobileNav(false); }}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
        <div className="sidebar-user"><div className="avatar">{me.user.displayName.slice(0, 1)}</div><div><strong>{me.user.displayName}</strong><span>{me.user.email}</span></div><button className="icon-button dark" onClick={logout} title="退出登录"><LogOut size={17} /></button></div>
      </aside>
      {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
      <main className="main-area">
        <header className="topbar"><button className="icon-button menu-button" onClick={() => setMobileNav(true)}><Menu size={20} /></button><div><h1>{titles[page].title}</h1><p>{titles[page].subtitle}</p></div><div className="topbar-actions">{page !== "overview" && page !== "audit" && <label className="app-picker"><Boxes size={16} /><select value={appId} onChange={(e) => setAppId(e.target.value)}>{applications.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={15} /></label>}<button className="icon-button bordered" onClick={reloadAll} title="刷新"><RefreshCw size={17} /></button></div></header>
        <div className="content">
          {page === "overview" && <OverviewView data={overview} server={serverStatus} history={serverHistory} />}
          {page === "applications" && <ApplicationsView applications={applications} reload={reloadAll} notify={notify} />}
          {page === "users" && <UsersView users={users} applications={applications} appId={appId} reload={reloadAll} notify={notify} />}
          {page === "plans" && <PlansView plans={plans} appId={appId} reload={reloadAll} notify={notify} />}
          {page === "payments" && <PaymentsView providers={providers} appId={appId} reload={reloadAll} notify={notify} />}
          {page === "orders" && <OrdersView orders={orders} users={users} plans={plans} appId={appId} reload={reloadAll} notify={notify} />}
          {page === "ledger" && <LedgerView items={ledger} />}
          {page === "audit" && <AuditView items={auditItems} />}
        </div>
        <footer><span>{selectedApp ? `当前应用：${selectedApp.name}` : "Account Hub"}</span><span>v0.3.2</span></footer>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
