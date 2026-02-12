# Mobile Responsiveness Guide

## Desktop (> 1400px)
```
┌──────────────────────────────────────────────────────────────┐
│  Header (Logo + Title + Stats)                               │
├────────┬─────────────────────────────────┬───────────────────┤
│        │                                 │                   │
│ Left   │    Center (Projects)            │   Right (520px)   │
│ 280px  │    Flexible width               │   Detail Panel    │
│        │                                 │                   │
│ Search │    Category > Status Groups     │   Project info    │
│ Sort   │    ┌──────┐ ┌──────┐ ┌──────┐  │   Comments        │
│ Filters│    │ Card │ │ Card │ │ Card │  │   Actions         │
│ +New   │    └──────┘ └──────┘ └──────┘  │                   │
│        │                                 │                   │
└────────┴─────────────────────────────────┴───────────────────┘
```

## Tablet (1000px - 1400px)
```
┌──────────────────────────────────────────────────────────────┐
│  Header (Logo + Title)                                       │
├────────┬─────────────────────────────────────────────────────┤
│        │                                 ┌───────────────────┐
│ Left   │    Center (Full width)          │  Right (Slides in)│
│ 280px  │                                 │  520px            │
│        │    ┌──────┐ ┌──────┐            │  Detail Panel     │
│ Search │    │ Card │ │ Card │            │  (overlay)        │
│ Sort   │    └──────┘ └──────┘            │                   │
│ Filters│                                 └───────────────────┘
│        │  Click card → Detail slides in from right
│        │  Click outside → Detail slides out
└────────┴─────────────────────────────────────────────────────┘
```

## Mobile (< 768px)
```
┌────────────────────────┐
│  Header (Logo only)    │
├────────────────────────┤
│  ┌──────────────────┐  │
│  │ Left Sidebar     │  │ ← Collapsed at top
│  │ Search           │  │   (scroll to access)
│  │ Sort             │  │
│  │ Filters          │  │
│  └──────────────────┘  │
├────────────────────────┤
│                        │
│  ┌──────────────────┐  │
│  │   Project Card   │  │
│  │   (Full width)   │  │
│  └──────────────────┘  │
│                        │
│  ┌──────────────────┐  │
│  │   Project Card   │  │
│  └──────────────────┘  │
│                        │
├────────────────────────┤
│  Detail Panel          │
│  (Slides up from       │ ← Click card →
│   bottom full screen)  │   Full screen overlay
└────────────────────────┘
```

## Responsive Breakpoints

### Desktop (> 1400px)
- **Left:** 280px fixed
- **Center:** Flexible (fills remaining space)
- **Right:** 520px fixed (increased from 420px)
- **Layout:** 3-column permanent

### Tablet (1000px - 1400px)
- **Left:** 280px fixed
- **Center:** Flexible (full width)
- **Right:** 520px overlay (slides in from right when card clicked)
- **Layout:** 2-column + overlay

### Mobile (< 768px)
- **Left:** Full width at top (scrollable section)
- **Center:** Full width (cards stack vertically)
- **Right:** Full screen overlay (slides up from bottom)
- **Layout:** Single column + full-screen overlay

## Interaction Patterns

### Desktop
- Select card → Detail shows immediately in right panel
- No modal, no overlay
- Persistent 3-column view

### Tablet
- Select card → Right panel slides in from right
- Click outside → Panel slides out
- Semi-transparent backdrop

### Mobile
- Scroll down to see filters
- Tap card → Detail panel slides up (full screen)
- Tap back/outside → Panel slides down
- Touch-optimized buttons

## Key Features

### Touch-Friendly
- Larger tap targets on mobile
- Swipe to dismiss detail panel
- No hover states (replaced with active states)

### Performance
- Lazy loading for large project lists
- Smooth animations (GPU-accelerated)
- No layout shift on resize

### Accessibility
- Keyboard navigation works
- Focus management in modals
- Screen reader friendly

## Current Stats
- Desktop width: **520px** detail panel (up from 420px)
- Mobile breakpoint: **1400px** (increased from 1200px)
- Card grid: Auto-fills based on available space
