import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ImportResult } from "./api";
import { formatNumber } from "./format";

/**
 * Import names from a Google Contacts export. The file is read in the browser
 * and posted as text; only name/number pairs are stored server-side.
 */
export function Contacts({ onClose }: { onClose: () => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState<Array<{ phone: string; name: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const { contacts, count } = await api.contacts();
    setCount(count);
    setSample(contacts.slice(0, 8));
  };

  useEffect(() => {
    refresh().catch(() => setCount(0));
  }, []);

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const text = await file.text();
      const result: ImportResult = await api.importContacts(text, file.name);
      setStatus(
        `Imported ${result.numbersImported} number${result.numbersImported === 1 ? "" : "s"} for ${result.contactsImported} contact${result.contactsImported === 1 ? "" : "s"}` +
          (result.skippedNumbers > 0
            ? ` — skipped ${result.skippedNumbers} unrecognized`
            : ""),
      );
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Contacts"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-header">
          <h2>Contacts</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <p className="sheet-text">
          {count === null
            ? "Loading…"
            : count === 0
              ? "No contacts imported yet."
              : `${count} phone number${count === 1 ? "" : "s"} in your address book.`}
        </p>

        <ol className="sheet-steps">
          <li>
            Open <strong>contacts.google.com</strong> on a computer.
          </li>
          <li>
            Select the contacts you want, then choose <strong>Export</strong>.
          </li>
          <li>
            Pick <strong>vCard</strong> or <strong>Google CSV</strong> and save
            the file.
          </li>
          <li>Choose that file below.</li>
        </ol>

        <input
          ref={fileRef}
          type="file"
          accept=".vcf,.csv,text/vcard,text/csv"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onFile(file);
          }}
        />

        {busy && <p className="sheet-text">Importing…</p>}
        {status && <p className="sheet-success">{status}</p>}
        {error && <p className="sheet-error">{error}</p>}

        {sample.length > 0 && (
          <div className="contact-sample">
            {sample.map((c) => (
              <div key={c.phone} className="contact-sample-row">
                <span>{c.name}</span>
                <span className="row-time">{formatNumber(c.phone)}</span>
              </div>
            ))}
            {count !== null && count > sample.length && (
              <p className="sheet-text">…and {count - sample.length} more</p>
            )}
          </div>
        )}

        {count !== null && count > 0 && (
          <button
            className="sheet-danger"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm("Remove all imported contact names?")) return;
              await api.clearContacts();
              setStatus("Contacts cleared");
              await refresh();
            }}
          >
            Clear all contacts
          </button>
        )}

        <p className="sheet-note">
          Names stay on your server — nothing is sent to Google. A name you set
          on an individual conversation always overrides the imported one.
        </p>
      </div>
    </div>
  );
}
