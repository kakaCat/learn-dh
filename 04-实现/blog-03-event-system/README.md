# Blog 03: Event System

Learn the five event dispatch modes in Cordis.

## Contents

- **Part 1: Five Event Dispatch Modes** - emit, parallel, serial, bail, waterfall
- **Part 2: Waterfall Deep Dive** - Short-circuit, modify parameters, caching

## Installation

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

## What You'll Learn

- Five event dispatch modes and their use cases
- Waterfall (onion model) for middleware patterns
- When to use each dispatch mode
- Advanced waterfall patterns

## Key Concepts

### Event Dispatch Modes

1. **emit** - Fire and forget, doesn't wait for async listeners
2. **parallel** - Wait for all listeners, executed concurrently
3. **serial** - Execute sequentially, can short-circuit (async)
4. **bail** - Execute sequentially, can short-circuit (sync only)
5. **waterfall** - Onion model, middleware pattern with `next()`

### Use Cases

- **emit** - Notifications, fire-and-forget events
- **parallel** - Multiple independent tasks
- **serial/bail** - Finding a handler, validation chains
- **waterfall** - Request processing pipeline, caching layers

## Source Files

- `lesson-03-events/` - Original event system lesson
