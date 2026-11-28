"use client";
// Offers to put the dealer page on the phone's home screen. Where the browser
// can install it with one tap, a button does it. Elsewhere a line says how.
// Nothing shows once the page is already running as an installed app.
import { useEffect, useState } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
const HIDE_KEY = "dealer-install-hidden";

export default function InstallHint() {
  const [ask, setAsk] = useState<InstallEvent | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    let hidden = false;
    try {
      hidden = window.localStorage.getItem(HIDE_KEY) === "1";
    } catch {
      /* storage blocked: the hint just shows */
    }
    const first = setTimeout(() => setShow(!installed && !hidden), 0);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setAsk(e as InstallEvent);
    };
    const onInstalled = () => setShow(false);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      clearTimeout(first);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!show) return null;
  const hide = () => {
    setShow(false);
    try {
      window.localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* storage blocked: it hides until reload */
    }
  };
  return (
    <div className="ih" role="note">
      <p>
        <b>Keep this on your phone&apos;s home screen.</b>{" "}
        {ask ? "It opens like an app, straight to your orders." : "In your browser's menu, choose Add to Home Screen (or Install). It then opens like an app, straight to your orders."}
      </p>
      <div className="inline">
        {ask && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await ask.prompt();
              const choice = await ask.userChoice?.catch(() => null);
              setAsk(null);
              if (choice?.outcome === "accepted") setShow(false);
            }}
          >
            Install
          </button>
        )}
        <button type="button" className="btn ghost" onClick={hide}>
          Not now
        </button>
      </div>
    </div>
  );
}
