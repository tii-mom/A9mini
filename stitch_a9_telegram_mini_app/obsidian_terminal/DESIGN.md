---
name: Obsidian Terminal
colors:
  surface: '#0f131c'
  surface-dim: '#0f131c'
  surface-bright: '#353943'
  surface-container-lowest: '#0a0e17'
  surface-container-low: '#181b25'
  surface-container: '#1c1f29'
  surface-container-high: '#262a34'
  surface-container-highest: '#31353f'
  on-surface: '#dfe2ef'
  on-surface-variant: '#bacbbc'
  inverse-surface: '#dfe2ef'
  inverse-on-surface: '#2c303a'
  outline: '#849587'
  outline-variant: '#3b4a3f'
  surface-tint: '#00e388'
  primary: '#b4ffcb'
  on-primary: '#00391e'
  primary-container: '#00f090'
  on-primary-container: '#00683b'
  inverse-primary: '#006d3e'
  secondary: '#a5e7ff'
  on-secondary: '#003543'
  secondary-container: '#00d2ff'
  on-secondary-container: '#00566a'
  tertiary: '#ffe9e9'
  on-tertiary: '#680017'
  tertiary-container: '#ffc3c4'
  on-tertiary-container: '#b60030'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#58ffa5'
  primary-fixed-dim: '#00e388'
  on-primary-fixed: '#00210f'
  on-primary-fixed-variant: '#00522e'
  secondary-fixed: '#b6ebff'
  secondary-fixed-dim: '#47d6ff'
  on-secondary-fixed: '#001f28'
  on-secondary-fixed-variant: '#004e60'
  tertiary-fixed: '#ffdada'
  tertiary-fixed-dim: '#ffb3b4'
  on-tertiary-fixed: '#40000b'
  on-tertiary-fixed-variant: '#920024'
  background: '#0f131c'
  on-background: '#dfe2ef'
  surface-variant: '#31353f'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 30px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
  body-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-numeric-lg:
    fontFamily: JetBrains Mono
    fontSize: 18px
    fontWeight: '700'
    lineHeight: 22px
    letterSpacing: -0.03em
  label-numeric-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: -0.02em
  label-numeric-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0em
  label-numeric-xs:
    fontFamily: JetBrains Mono
    fontSize: 9px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.04em
  label-caps:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.06em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.5rem
  gutter-desktop: 0.75rem
  margin: 0.75rem
  margin-desktop: 1rem
  space-xs: 0.125rem
  space-sm: 0.25rem
  space-md: 0.5rem
  space-lg: 0.75rem
  space-xl: 1rem
---

## Brand & Style

This design system establishes an ultra-dense, institutional-grade execution interface tailored specifically for the Telegram Mini App (TMA) viewport on TON. The interface channels the relentless precision of legacy institutional market workstations (Bloomberg, Reuters Eikon) fused with high-frequency crypto trading aesthetics.

Targeting institutional traders, algorithmic execution desks, and sophisticated DeFi participants, the visual environment communicates uncompromising reliability, absolute data integrity, and sub-millisecond execution clarity. 

The aesthetic is built upon **Techno-Financial Brutalism meets Tactical Glassmorphism**:
- Deep obsidian foundation layers to reduce eye strain in continuous trading environments.
- Micro-engineered data density: zero wasted negative space, zero decorative fluff.
- Luminescent tactical telemetry: glowing status accents convey instant situational awareness (bullish expansion, liquidation thresholds, pending settlements).
- Compact, viewport-bounded architecture engineered specifically to feel native inside Telegram’s mobile container while preserving desktop terminal rigor.

## Colors

The palette is strictly calibrated for maximum visual differentiation under dense information conditions. Darkness is layered to establish structural depth rather than sheer emptiness.

### Canvas & Surface Hierarchy
- **Base Canvas (`#0A0E17`):** The foundational obsidian layer beneath all containers.
- **Surface Layer 1 (`#111827`):** Structural panels, terminal viewports, primary cards.
- **Surface Layer 2 (`#161F30`):** Elevated widgets, nested order book segments, input fields.
- **Micro-Border Stroke (`#1F293D`):** Hairline separation defining high-density cell boundaries.

### State & Execution Signals
- **Electric Bloomberg Green (`#00F090` / `#10B981`):** Bullish Delta, verified signatures, target thresholds, affirmative execution states.
- **Financial Crimson (`#FF3B57` / `#EF4444`):** Shortfall alerts, stop-loss triggers, slippage breaches, ask-side book volume.
- **Terminal Gold/Amber (`#F59E0B`):** Warm-up intervals, memory pool pending, consensus lag, warning alerts.
- **TON Cyan (`#00D2FF`):** Telegram Open Network native mechanics, Jetton smart routing, network gas metrics, and liquidity telemetry.

## Typography

The typography pairs **Inter** for UI control architecture and descriptive taxonomy with **JetBrains Mono** for quantitative tracking.

### Operational Principles
- **Mandatory Tabular Alignment:** All market figures, price ladders, balances, slippage parameters, and timestamps must leverage JetBrains Mono with tabular figures enabled (`font-variant-numeric: tabular-nums`) to prevent layout shifts during live tick changes.
- **Caps for Secondary Context:** Sub-labels, book column indices, status qualifiers, and protocol flags use `label-caps` in uppercase format with deliberate tracking to ensure legibility at micro scales.
- **Density Over Scale:** Headline sizes are purposefully constrained (maximum 24px) to retain maximum data volume above the fold inside the Telegram Webview.

## Layout & Spacing

The layout is built on a tight 4px baseline sub-grid configured explicitly for high-density mobile viewports (Telegram Mini App 390px-430px base width).

### Layout System
- **Viewport Utilization:** Vertical scrolling is minimized on core trading tabs. Primary trading panels (order book, order ticket, depth bar) are arranged in a segmented fluid grid constrained to 100vh of the client canvas.
- **Cell Structure:** Elements are packed closely using `space-xs` (2px) and `space-sm` (4px) inner paddings for metrics and labels, expanding to `space-md` (8px) for modular groupings.
- **Breakpoints:**
  - `Mobile / TMA Viewport` (< 480px): Single-column stacked terminal, segmented tab navigation, 12px outer canvas margin.
  - `Expanded Tablet / Web Desktop` (≥ 480px): Dual-pane multi-window terminal layout with order ticket pinned right and 16px outer canvas margin.

## Elevation & Depth

Visual hierarchy does not rely on heavy drop shadows, which introduce visual noise in dense interfaces. Depth is achieved via **Tonal Stacking**, **Luminescent Edges**, and **Frosted Tactical Glass**.

### Layering Hierarchy
1. **Root Bed (`#0A0E17`):** Non-interactive foundation layer.
2. **Terminal Tiles (`#111827`):** Outlined with 1px solid `#1F293D`. No elevation shadow.
3. **Active/Focused Cells (`#161F30`):** Outlined with 1px solid `rgba(0, 240, 144, 0.3)` or `rgba(0, 210, 255, 0.3)` accompanied by a minimal 0px 0px 8px glow tinted to the respective accent.
4. **Modal Overlays & Telegram Popups:** Background set to `#111827` at 85% opacity with `backdrop-filter: blur(16px)` and a top edge micro-highlight of `1px solid rgba(255, 255, 255, 0.08)`.

### Tactical Depth Meters
Horizontal depth visualization in the order book uses high-precision background fill bars rendered with semi-transparent fills (`rgba(0, 240, 144, 0.12)` for bids, `rgba(255, 59, 87, 0.12)` for asks) aligned behind tabular monospace figures.

## Shapes

The design system enforces a sharp, precision-machined visual style. Soft, bubbly corners are avoided in favor of crisp financial geometry.

- **Base Radius (0.25rem / 4px):** Standard interactive buttons, market depth cells, token tags, input fields, and metric wrappers.
- **Large Radius (0.5rem / 8px):** Terminal parent modules, glassmorphism bottom sheets, order confirmation modals.
- **Extra-Large Radius (0.75rem / 12px):** Root TMA view boundaries and bottom action drawers.
- **Zero Radius (0px):** Order book volume depth rows, split execution buttons, and continuous ticker tapes to maximize screen usage.

## Components

### Buttons & Interactive Triggers
- **Primary Execution (Long/Buy):** Filled `#00F090` background with deep `#0A0E17` bold typography. Active state introduces inset 1px inner glow.
- **Destructive Execution (Short/Sell):** Filled `#FF3B57` background with pure white typography.
- **Secondary Action:** `#161F30` background, `#1F293D` border stroke, `#00D2FF` or neutral light gray text.
- **Touch Target Optimization:** Height fixed at 36px for dense sub-actions, 44px minimum for terminal execution triggers.

### Order Book & Depth Meters
- Rendered in a strict 2-column or stacked layout.
- Spread tracker pinned in the center using `label-numeric-sm` displaying absolute pip spread and percentage differential in `#F59E0B`.
- Depth volume bars must stretch from the inner boundary outward using hardware-accelerated CSS transforms.

### Data Chips & Status Badges
- Minified telemetry chips: Height of 18px–20px, font `label-numeric-xs`, 4px border radius.
- States:
  - **Bullish / Verified:** `rgba(0, 240, 144, 0.1)` background, `#00F090` text, 1px border `rgba(0, 240, 144, 0.3)`.
  - **Bearish / Liquidation:** `rgba(255, 59, 87, 0.1)` background, `#FF3B57` text, 1px border `rgba(255, 59, 87, 0.3)`.
  - **Network / TON Route:** `rgba(0, 210, 255, 0.1)` background, `#00D2FF` text, 1px border `rgba(0, 210, 255, 0.3)`.

### Input Fields & Steppers
- Low-profile dark containers (`#111827`) with inset borders (`#1F293D`).
- Integrated asset prefix/suffix (e.g., `TON`, `USDT`, `JETTON`) displayed in uppercase `label-caps` muted silver (`#94A3B8`).
- Increment/decrement quick multipliers (`25%`, `50%`, `75%`, `MAX`) embedded directly into the lower margin of the input cell.

### Financial Terminal Cards
- Continuous panels divided by hairline borders without extra outer padding.
- Card headers feature standard 28px height, containing ticker symbol, real-time 24h percentage delta, and quick-expand telemetry toggle.