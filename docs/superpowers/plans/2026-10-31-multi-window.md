# Multi-window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several Trek windows open at once, one project each, as specified in `docs/superpowers/specs/2026-10-31-multi-window-design.md`.

**Architecture:** One main process. `src/main/windows.ts` owns windows, project claims, the close handshake and restore. Pty events and MCP calls are routed to the owning window.

**Tech Stack:** Electron, TypeScript, React/zustand, `node --test`, Playwright smoke scripts.

---

### Task 1: Pure rules
**Files:** Create `src/main/windowRules.ts`, `scripts/windowRules.test.mjs`
- [ ] Write failing tests for `decideOpen`, `parseOpenWindows`, `boundsOnScreen`
- [ ] Implement, run `npm test`

### Task 2: Pty routing
**Files:** Create `src/main/hosts/ptyWindows.ts`; modify `src/main/pty.ts`, `hosts/LocalHost.ts`, `hosts/RemoteHost.ts`
- [ ] Record the owning window at `pty:spawn`, send `pty:*` only there
- [ ] Add `releaseWindowPtys(webContentsId)`, detaching through the owning host

### Task 3: MCP routing
**Files:** Modify `src/main/mcp.ts`
- [ ] One token and config file per window; route by token; `releaseMcpWindow`; remove stale files at server start

### Task 4: Window registry, close, quit, restore
**Files:** Create `src/main/windows.ts`; modify `src/main/index.ts`, `src/main/project.ts`
- [ ] Move `createWindow`; track claims; handshake with 5s timer; quit sequence; `open-windows.json`
- [ ] Open flow and Save As refusal in `project.ts`; New Window menu item

### Task 5: Renderer
**Files:** Create `src/renderer/src/windowLifecycle.ts`; modify `src/preload/index.ts`, `App.tsx`, `persistence.ts`, `store.ts`, `components/StartScreen.tsx`
- [ ] Report project state, handle close requests, take the initial project, handle `null` opens
- [ ] Remove the unused `closeProject` and `menu:new-project`

### Task 6: Verification
**Files:** Create `scripts/windows-smoke.mjs`; modify `package.json`, existing smokes, `README.md`
- [ ] Smoke covers every check in the spec's Testing section
- [ ] Run `npm run typecheck`, `npm test`, all smokes
