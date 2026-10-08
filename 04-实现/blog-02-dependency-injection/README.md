# Blog 02: Dependency Injection and Service Management

Learn how Cordis automatically manages service loading order through dependency injection.

## Contents

- **Part 1: Dependency Injection Basics** - Declare dependencies, automatic ordering
- **Part 2: Optional Dependencies** - Flexible dependency declarations
- **Part 3: Loading Order Demo** - Deep dive into dependency calculation

## Installation

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

## What You'll Learn

- How to declare service dependencies with `inject`
- How Cordis automatically calculates loading order
- Optional dependencies with `?` prefix
- Extending Context types with TypeScript

## Key Concepts

### Service Class
Services extend the `Service` base class and use `super(ctx, 'name', true)` to register themselves.

### Dependency Injection
Use static `inject` property to declare dependencies:
```typescript
class CacheService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    // Can safely use ctx.database here
  }
}
CacheService.inject = ['database']
```

### Optional Dependencies
Prefix dependency name with `?` for optional dependencies:
```typescript
AnalyticsService.inject = ['?cache']
```

## Source Files

- `lesson-02-inject/` - Original dependency injection lesson
