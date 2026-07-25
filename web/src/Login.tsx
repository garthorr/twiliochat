import { useState } from "react";
import { api, ApiError } from "./api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "Wrong password"
          : "Could not sign in — is the server configured?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-icon">💬</div>
        <h1>TwilioChat</h1>
        <p className="login-sub">Enter your password to continue</p>
        <input
          type="password"
          autoFocus
          value={password}
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={busy || !password}>
          Sign In
        </button>
      </form>
    </div>
  );
}
