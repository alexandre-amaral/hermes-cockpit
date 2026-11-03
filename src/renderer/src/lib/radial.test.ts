// Geometria do donut e regra de cor dos medidores (ver radial.ts). Puro: sem DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  displayTone,
  INFO_TONE,
  RADIAL_FULL_PCT,
  radialGeometry,
  radialLabel,
  toneColor,
  usageTone,
  usageToneOf,
} from './radial.ts'

const SIZE = 56
const STROKE = 5
const R = (SIZE - STROKE) / 2
const C = 2 * Math.PI * R

test('geometria: raio e circunferência saem de size/strokeWidth', () => {
  const g = radialGeometry(50, SIZE, STROKE)
  assert.equal(g.r, R)
  assert.ok(Math.abs(g.circumference - C) < 1e-9)
  assert.equal(g.dasharray, g.circumference)
})

test('0% = só o trilho (sem arco, logo sem o pontinho do cap)', () => {
  const g = radialGeometry(0, SIZE, STROKE)
  assert.equal(g.pct, 0)
  assert.equal(g.showArc, false)
  assert.ok(Math.abs(g.dashoffset - C) < 1e-9, 'dashoffset cheio = nada desenhado')
})

test('50% = meio círculo', () => {
  const g = radialGeometry(50, SIZE, STROKE)
  assert.equal(g.showArc, true)
  assert.ok(Math.abs(g.dashoffset - C / 2) < 1e-9)
  assert.equal(g.linecap, 'round')
})

test('100% = anel fechado, dashoffset 0 e cap reto (sem calombo)', () => {
  const g = radialGeometry(100, SIZE, STROKE)
  assert.equal(g.pct, 100)
  assert.equal(g.showArc, true)
  assert.equal(g.dashoffset, 0)
  assert.equal(g.linecap, 'butt')
})

test(`≥${RADIAL_FULL_PCT}% fecha o anel (sem gap estranho)`, () => {
  const g = radialGeometry(99.6, SIZE, STROKE)
  assert.equal(g.pct, 100)
  assert.equal(g.dashoffset, 0)
  // logo abaixo do limiar continua arco parcial
  const under = radialGeometry(99.4, SIZE, STROKE)
  assert.equal(under.pct, 99.4)
  assert.ok(under.dashoffset > 0)
  assert.equal(under.linecap, 'round')
})

test('null/undefined/NaN = anel vazio e "—"', () => {
  for (const v of [null, undefined, Number.NaN]) {
    const g = radialGeometry(v, SIZE, STROKE)
    assert.equal(g.pct, null, `valor ${String(v)}`)
    assert.equal(g.showArc, false)
    assert.ok(Math.abs(g.dashoffset - C) < 1e-9)
    assert.equal(radialLabel(g.pct), '—')
  }
})

test('valores fora da faixa são presos em 0–100', () => {
  assert.equal(radialGeometry(-20, SIZE, STROKE).pct, 0)
  assert.equal(radialGeometry(420, SIZE, STROKE).pct, 100)
})

test('rótulo central é a % inteira', () => {
  assert.equal(radialLabel(0), '0%')
  assert.equal(radialLabel(67.6), '68%')
  assert.equal(radialLabel(100), '100%')
})

test('tom de uso: verde <80, laranja ≥80, vermelho ≥90', () => {
  assert.equal(usageTone(0), 'phos')
  assert.equal(usageTone(79.9), 'phos')
  assert.equal(usageTone(80), 'warn')
  assert.equal(usageTone(89.9), 'warn')
  assert.equal(usageTone(90), 'alert')
  assert.equal(usageTone(100), 'alert')
})

test('sem dado = tom informativo (accent/roxo), nunca verde', () => {
  assert.equal(usageToneOf(null), INFO_TONE)
  assert.equal(usageToneOf(undefined), INFO_TONE)
  assert.equal(usageToneOf(Number.NaN), INFO_TONE)
  assert.equal(usageToneOf(12), 'phos')
  assert.equal(usageToneOf(95), 'alert')
})

test('cada tom resolve para um token do tema', () => {
  assert.equal(toneColor('phos'), 'var(--color-phos)')
  assert.equal(toneColor('warn'), 'var(--color-warn)')
  assert.equal(toneColor('alert'), 'var(--color-alert)')
  assert.equal(toneColor(INFO_TONE), 'var(--color-amber)')
})

test('displayTone concorda com a % mostrada (arredondada)', () => {
  // 89.6 aparece como "90%": o anel tem de ficar vermelho, não laranja
  assert.equal(usageToneOf(89.6), 'warn')
  assert.equal(displayTone(89.6), 'alert')
  assert.equal(displayTone(89.4), 'warn')
  assert.equal(displayTone(79.5), 'warn')
  assert.equal(displayTone(79.4), 'phos')
  assert.equal(displayTone(null), INFO_TONE)
})
