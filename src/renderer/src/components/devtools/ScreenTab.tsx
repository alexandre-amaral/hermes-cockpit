import { useCallback, useEffect, useRef, useState } from 'react'
import { hasMain, invoke } from '../../lib/ipc'
import { errMsg, isNoHandler, openIn } from '../../lib/devtools'
import { HOST_THIS, IS_MAC } from '../../lib/platform'
import { ErrorState, ToolButton } from './ui'

// Aba Tela: screenshot sob demanda via ops:screenshot (desktopCapturer no
// main) + auto-refresh opcional de 5s (só com a aba visível e a janela ativa).
// Funciona em qualquer plataforma; a instrução de permissão de Gravação de
// Tela é só do macOS (fora dele o Electron captura sem TCC).

const PERM_RE = /permiss|grava[cç][aã]o de tela|screen ?recording|not authori[sz]ed|denied|tcc/i
const AUTO_MS = 5000

export function ScreenTab({ active }: { active: boolean }) {
  const [shot, setShot] = useState<{ dataUrl: string; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(false)
  const inflight = useRef(false)

  const capture = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    try {
      const r = await invoke<{ dataUrl: string }>('ops:screenshot')
      if (!r || typeof r.dataUrl !== 'string' || !r.dataUrl.startsWith('data:image')) throw new Error('resposta sem imagem')
      setShot({ dataUrl: r.dataUrl, at: Date.now() })
      setError(null)
    } catch (e) {
      setError(isNoHandler(e) ? 'canal ops:screenshot ainda não disponível no main' : errMsg(e))
      setAuto(false)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!auto || !active) return
    const t = window.setInterval(() => {
      if (!document.hidden) void capture()
    }, AUTO_MS)
    return () => window.clearInterval(t)
  }, [auto, active, capture])

  // Instrução de TCC só vale no macOS; no Windows/Linux a falha é outra coisa.
  const perm = error ? IS_MAC && PERM_RE.test(error) : false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1">
        <ToolButton tone="amber" disabled={busy || !hasMain()} onClick={() => void capture()}>
          {busy ? 'capturando…' : 'capturar'}
        </ToolButton>
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-dim">
          <input type="checkbox" checked={auto} disabled={!hasMain()} onChange={(e) => setAuto(e.target.checked)} />
          auto 5s
        </label>
        {auto && active && <span className="hc-pulse-dot h-1.5 w-1.5 rounded-full bg-phos" title="auto-refresh ativo" />}
        {shot && (
          <span className="ml-auto text-[10px] text-faint">
            {new Date(shot.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>

      {error &&
        (perm ? (
          <div className="hc-fade-in m-3 rounded border border-amber/40 bg-amber/5 px-3 py-2 text-[11px] leading-relaxed">
            <div className="label text-amber">permissão de gravação de tela</div>
            <ol className="mt-1 list-decimal pl-4 text-dim">
              <li>Abra Ajustes do Sistema › Privacidade e Segurança › Gravação de Tela (e Áudio do Sistema).</li>
              <li>Ative “Hermes Cockpit” (ou o Electron, em dev).</li>
              <li>Feche e reabra o app — o macOS só aplica após reiniciar.</li>
            </ol>
            <div className="mt-2 flex gap-1">
              <ToolButton
                onClick={() =>
                  void openIn({ kind: 'url', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' })
                }
              >
                abrir ajustes
              </ToolButton>
              <ToolButton onClick={() => void capture()}>tentar de novo</ToolButton>
            </div>
            <div className="mt-1 break-words text-[10px] text-faint">{error}</div>
          </div>
        ) : (
          <ErrorState title="captura falhou" detail={error} onRetry={() => void capture()} />
        ))}

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-void/60 p-2">
        {shot ? (
          <img
            src={shot.dataUrl}
            alt={`tela ${HOST_THIS}`}
            className="hc-fade-in max-h-full max-w-full rounded border border-edge object-contain"
            onDoubleClick={() => void capture()}
          />
        ) : !error ? (
          <div className="text-center text-[11px] leading-relaxed text-faint">
            {hasMain() ? `capture a tela ${HOST_THIS} sob demanda.` : 'captura indisponível fora do app.'}
            <br />
            nada é capturado sem você pedir.
          </div>
        ) : null}
      </div>
    </div>
  )
}
