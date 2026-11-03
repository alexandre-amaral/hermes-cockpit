import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editMenu } from './menu.ts'

test('macOS mantém o menu Edit nativo', () => {
  assert.deepEqual(editMenu('darwin'), { role: 'editMenu' })
})

test('Windows/Linux: nenhum acelerador de edição é registrado no sistema', () => {
  for (const platform of ['win32', 'linux']) {
    const m = editMenu(platform)
    assert.equal(m.label, 'Edit')
    const items = (m.submenu as { role?: string; type?: string; registerAccelerator?: boolean }[]) ?? []
    const roles = items.filter((i) => i.role).map((i) => i.role)
    // o conjunto que o Chromium trata nativamente em inputs
    assert.deepEqual(roles, ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'], platform)
    for (const i of items) {
      if (i.type === 'separator') continue
      assert.equal(i.registerAccelerator, false, `${platform}: ${i.role} não pode registrar acelerador`)
    }
    // sem isto o terminal nunca receberia Ctrl+C/Ctrl+A
    for (const role of ['copy', 'paste', 'selectAll']) {
      assert.equal(items.find((i) => i.role === role)?.registerAccelerator, false, `${platform}: ${role}`)
    }
  }
})
