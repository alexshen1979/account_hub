import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, RefreshCw, ShieldCheck } from "lucide-react";
import { api, post } from "./api";

interface ConnectContext {
  application: { id: string; name: string; slug: string; allowRegistration: boolean };
  user: null | { id: string; email: string; displayName: string };
  membership: boolean;
}

export default function Connect() {
  const params = new URLSearchParams(window.location.search);
  const appSlug = params.get("app") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const [context, setContext] = useState<ConnectContext | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams({ app: appSlug, redirect_uri: redirectUri });
      setContext(await api<ConnectContext>(`/api/v1/connect/context?${query}`));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "授权请求无效");
    }
  }, [appSlug, redirectUri]);
  useEffect(() => { refresh(); }, [refresh]);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (mode === "register") {
        await post("/api/v1/auth/register", { applicationSlug: appSlug, displayName, email, password });
      } else {
        await post("/api/v1/auth/login", { email, password });
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally { setLoading(false); }
  }

  async function authorize() {
    setLoading(true);
    setError("");
    try {
      const result = await post<{ redirectUrl: string }>("/api/v1/connect/authorize", {
        app: appSlug,
        redirectUri,
        state,
      });
      window.location.assign(result.redirectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "授权失败");
      setLoading(false);
    }
  }

  return (
    <main className="connect-shell">
      <section className="connect-panel">
        <div className="connect-brand"><div className="brand-mark"><ShieldCheck size={25} /></div><span>ACCOUNT HUB</span></div>
        {!context ? <div className="connect-loading">{error || "正在核验授权请求"}</div> : (
          <>
            <div className="connect-heading"><span>登录到</span><h1>{context.application.name}</h1></div>
            {!context.user ? (
              <>
                <div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>{context.application.allowRegistration && <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>}</div>
                <form className="connect-form" onSubmit={authenticate}>
                  {mode === "register" && <label className="field"><span>昵称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>}
                  <label className="field"><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" /></label>
                  <label className="field"><span>密码</span><input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
                  {error && <div className="form-error">{error}</div>}
                  <button className="primary-button full-button" disabled={loading}>{loading && <RefreshCw className="spin" size={16} />}{mode === "login" ? "登录并继续" : "创建账号并继续"}</button>
                </form>
              </>
            ) : (
              <div className="authorize-view">
                <div className="authorized-user"><span className="authorize-avatar">{context.user.displayName.slice(0, 1)}</span><div><strong>{context.user.displayName}</strong><span>{context.user.email}</span></div><Check size={18} /></div>
                {!context.membership && <p>继续后，该账号将加入 {context.application.name}。</p>}
                {error && <div className="form-error">{error}</div>}
                <button className="primary-button full-button" onClick={authorize} disabled={loading}>{loading ? <RefreshCw className="spin" size={16} /> : <ArrowRight size={17} />}授权并返回</button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
