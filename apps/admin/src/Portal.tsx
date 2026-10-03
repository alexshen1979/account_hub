import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Check, CreditCard, ExternalLink, LogOut, Package, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import { api, formatCredits, formatMoney, formatTime, post } from "./api";

interface Plan {
  id: string;
  name: string;
  code: string;
  price_cents: number;
  currency: string;
  included_credits: string;
  validity_days: number;
}
interface Context { application: { id: string; name: string; slug: string }; plans: Plan[] }
interface Order { id: string; order_no: string; provider: "mock" | "epay"; plan_name: string; amount_cents: number; currency: string; credits: string; status: string; created_at: string }
interface Account {
  user: { id: string; email: string; displayName: string };
  account: { application_name: string; available: string; frozen: string };
  orders: Order[];
}

function AuthPanel({ context, onAuthenticated }: { context: Context; onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mode === "register") {
        await post("/api/v1/auth/register", { applicationSlug: context.application.slug, displayName, email, password });
      } else {
        await post("/api/v1/auth/login", { email, password });
      }
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally { setLoading(false); }
  }
  return (
    <main className="portal-auth">
      <section className="portal-auth-panel">
        <div className="portal-product"><div className="brand-mark"><ShieldCheck size={25} /></div><div><span>ACCOUNT CENTER</span><h1>{context.application.name}</h1></div></div>
        <div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button></div>
        <form onSubmit={submit}>
          {mode === "register" && <label className="field"><span>昵称</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></label>}
          <label className="field"><span>邮箱</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
          <label className="field"><span>密码</span><input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full-button" disabled={loading}>{loading && <RefreshCw className="spin" size={16} />}{mode === "login" ? "登录" : "创建账号"}</button>
        </form>
      </section>
    </main>
  );
}

export default function Portal() {
  const slug = new URLSearchParams(window.location.search).get("app") ?? "";
  const [context, setContext] = useState<Context | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState("");
  const loadAccount = useCallback(async () => {
    try { setAccount(await api<Account>(`/api/v1/portal/${encodeURIComponent(slug)}/account`)); }
    catch { setAccount(null); }
    finally { setChecked(true); }
  }, [slug]);
  useEffect(() => {
    if (!slug) { setChecked(true); return; }
    api<Context>(`/api/v1/portal/${encodeURIComponent(slug)}/context`).then(setContext).catch((error) => setMessage(error.message));
    loadAccount();
    if (new URLSearchParams(window.location.search).get("payment") === "returned") {
      setMessage("已返回账户中心，支付结果以平台异步通知为准");
    }
  }, [slug, loadAccount]);
  async function recharge(planId: string) {
    try {
      const result = await post<{ checkoutUrl?: string }>(`/api/v1/portal/${encodeURIComponent(slug)}/orders`, { planId });
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
      await loadAccount();
      setMessage("订单已创建");
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "创建订单失败"); }
  }
  async function pay(order: Order) {
    try {
      if (order.provider === "epay") {
        const result = await post<{ checkoutUrl: string }>(`/api/v1/portal/${encodeURIComponent(slug)}/orders/${order.id}/checkout`);
        window.location.assign(result.checkoutUrl);
        return;
      }
      await post(`/api/v1/portal/${encodeURIComponent(slug)}/orders/${order.id}/mock-pay`);
      await loadAccount();
      setMessage("支付成功，额度已到账");
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "支付失败"); }
  }
  async function logout() { await post("/api/v1/auth/logout"); setAccount(null); }

  if (!slug) return <main className="portal-auth"><section className="portal-auth-panel"><div className="portal-product"><div className="brand-mark"><ShieldCheck size={25} /></div><div><span>ACCOUNT CENTER</span><h1>缺少应用标识</h1></div></div><div className="form-error">请使用管理后台生成的用户入口地址。</div></section></main>;
  if (!context || !checked) return <div className="boot-screen"><div className="brand-mark"><ShieldCheck size={24} /></div>{message && <div className="portal-error">{message}</div>}</div>;
  if (!account) return <AuthPanel context={context} onAuthenticated={loadAccount} />;

  return (
    <div className="portal-shell">
      <header className="portal-header"><div className="portal-brand"><div className="brand-mark small"><ShieldCheck size={20} /></div><div><strong>{context.application.name}</strong><span>账户中心</span></div></div><div className="portal-user"><div><strong>{account.user.displayName}</strong><span>{account.user.email}</span></div><button className="icon-button bordered" onClick={logout} title="退出登录"><LogOut size={17} /></button></div></header>
      <main className="portal-main">
        <section className="balance-band"><div><span>可用额度</span><strong>{formatCredits(account.account.available)}</strong></div><div><span>冻结额度</span><strong>{formatCredits(account.account.frozen)}</strong></div><WalletCards size={34} /></section>
        <section className="portal-section"><div className="section-heading"><div><h2>充值套餐</h2><p>选择需要的额度</p></div><Package size={20} /></div><div className="portal-plans">{context.plans.map((plan) => <article key={plan.id}><span className="plan-code">{plan.code}</span><h3>{plan.name}</h3><strong>{formatCredits(plan.included_credits)} <small>额度</small></strong><div><span>{plan.validity_days ? `${plan.validity_days} 天` : "长期有效"}</span><button className="primary-button" onClick={() => recharge(plan.id)}><CreditCard size={16} />{formatMoney(plan.price_cents, plan.currency)}</button></div></article>)}</div></section>
        <section className="portal-section"><div className="section-heading"><div><h2>充值记录</h2><p>最近 50 笔订单</p></div></div><div className="table-wrap"><table><thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>额度</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>{account.orders.map((order) => <tr key={order.id}><td><code>{order.order_no}</code></td><td>{order.plan_name}</td><td>{formatMoney(order.amount_cents, order.currency)}</td><td>{formatCredits(order.credits)}</td><td>{order.status === "paid" ? <span className="status status-paid">已支付</span> : <span className="status status-pending">待支付</span>}</td><td>{formatTime(order.created_at)}</td><td className="align-right">{order.status === "pending" && <button className="secondary-button compact" onClick={() => pay(order)}>{order.provider === "epay" ? <><ExternalLink size={15} />继续支付</> : <><Check size={15} />模拟支付</>}</button>}</td></tr>)}</tbody></table>{account.orders.length === 0 && <div className="empty"><CreditCard size={29} /><span>暂无充值记录</span></div>}</div></section>
      </main>
      {message && <button className="toast portal-toast" onClick={() => setMessage("")}>{message}</button>}
    </div>
  );
}
