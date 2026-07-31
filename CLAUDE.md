# CLAUDE.md

## Project name

Legacy VB.NET Workbench for VS Code

## Purpose

This repository is for a VS Code extension or companion tool that makes legacy VB.NET WinForms projects easier to inspect and edit without changing the existing Visual Studio project format.

The tool does **not** aim to replace Visual Studio 2013.

The intended division of responsibilities is:

### VS Code side

- Edit `.vb` files
- Search across many files
- Perform multi-file operations
- Use modern editor features
- Display the logical structure defined by `.sln` and legacy `.vbproj`
- Open files that physically exist outside the project directory
- Run MSBuild
- Launch the compiled executable
- Show project constraints and unresolved items
- Warn before editing `Designer.vb`, `.resx`, and other generated/designer-managed files

### Visual Studio 2013 side

- WinForms designer
- Complex debugging
- Project property editing
- Visual Studio-specific operations

The main objective is:

> Reduce the amount of time spent working directly in Visual Studio 2013.

---

## User environment

Assume the following environment unless the user explicitly says otherwise:

- Windows
- Visual Studio 2013
- VB.NET WinForms
- Legacy `.NET Framework`
- MSBuild 12.0
- Development is performed on a remote development PC through RDP
- VS Code will also run on that remote PC
- Existing projects may not use Git
- Source files may be spread across multiple folders or drives
- `.sln` and `.vbproj` may refer to files outside the project folder
- Visual Studio Solution Explorer may show a logical tree different from the physical directory structure
- Legacy MSBuild metadata may include:
  - `Compile Include`
  - `EmbeddedResource`
  - `Content`
  - `None`
  - `ProjectReference`
  - `Reference`
  - `COMReference`
  - `Link`
  - `DependentUpon`
  - `SubType`
  - `Import`
  - `Condition`
  - `Choose`
  - `When`
  - `Otherwise`
  - `AutoGen`
  - `DesignTime`
  - `DesignTimeSharedInput`
  - `Generator`
  - `LastGenOutput`

---

## Current development focus

Do not design the complete product first.

The first target is only:

> Read one legacy `.vbproj`, build its logical file tree, and display that tree in a dedicated VS Code sidebar.

The preferred implementation language is TypeScript.

---

## MVP scope

### Include in the first prototype

1. Select a `.vbproj` file
2. Parse XML
3. Read these item types:
   - `Compile`
   - `EmbeddedResource`
   - `Content`
   - `None`
4. Resolve plain relative paths and absolute paths
5. Treat `Link` as the logical path
6. Use `DependentUpon` to create parent-child relationships
7. Build logical folders from the logical path
8. Show the result in a dedicated VS Code `TreeView`
9. Open the physical file when the user clicks an item
10. Show warning status for:
    - Missing files
    - Unresolved MSBuild expressions
    - Wildcards
    - Conditional items
11. Warn before opening:
    - `*.Designer.vb`
    - `*.resx`
    - `.settings`
    - generated files where detectable
12. Add a manual refresh command

### Explicitly exclude from the first prototype

- WinForms designer replacement
- Debugger implementation
- Full Visual Studio Solution Explorer parity
- Full MSBuild evaluation
- Evaluation of `Condition`
- Expansion of imported `.targets` or `.props`
- Expansion of `$(Property)`, `@(Item)`, or `%(Metadata)`
- Wildcard expansion
- Solution Folder support
- Automatic file watching
- MSBuild execution
- Executable launch
- Visual Studio launch
- Project property editing
- Hard blocking of file edits

---

## Core technical distinction

Always distinguish between:

1. Static XML interpretation
2. Fully evaluated MSBuild state

The first prototype implements only static XML interpretation.

For example, the following cannot be resolved correctly by XML parsing alone:

```xml
<Compile Include="$(SharedSourceRoot)\Common\Helper.vb">
  <Link>Common\Helper.vb</Link>
</Compile>
```

```xml
<ItemGroup Condition="'$(Configuration)' == 'Debug'">
  <Compile Include="DebugOnly.vb" />
</ItemGroup>
```

```xml
<Import
  Project="$(CustomTargetsPath)\Company.targets"
  Condition="Exists('$(CustomTargetsPath)\Company.targets')" />
```

When an item cannot be safely evaluated, preserve it and mark it as unresolved. Do not guess.

A later phase may use a small `.NET Framework` helper process based on `Microsoft.Build.Evaluation.Project` to obtain evaluated items.

---

## Preferred source structure

Start simple:

```text
legacy-vb-workbench/
├─ package.json
├─ tsconfig.json
├─ resources/
│  └─ legacy-vb.svg
└─ src/
   ├─ extension.ts
   ├─ types.ts
   ├─ vbprojParser.ts
   ├─ logicalTreeBuilder.ts
   └─ legacyProjectTreeProvider.ts
```

Add these only after the first tree works:

```text
src/
├─ slnParser.ts
├─ commands/
│  ├─ selectSolutionCommand.ts
│  ├─ buildSolutionCommand.ts
│  └─ openVisualStudioCommand.ts
├─ services/
│  ├─ msbuildLocator.ts
│  ├─ buildService.ts
│  └─ visualStudioLauncher.ts
└─ diagnostics/
   └─ projectDiagnostics.ts
```

---

## Recommended packages

Prefer a small dependency set.

Initial candidates:

```bash
npm install fast-xml-parser
```

Development normally uses the standard VS Code extension TypeScript template.

Avoid adding a framework unless the prototype clearly requires it.

---

## Initial domain model

Use a domain model independent of `vscode.TreeItem`.

```ts
export type ProjectItemKind =
  | "Compile"
  | "EmbeddedResource"
  | "Content"
  | "None"
  | "ProjectReference"
  | "Reference"
  | "COMReference"
  | "Folder";

export interface ProjectItem {
  kind: ProjectItemKind;
  include: string;
  sourcePath?: string;
  logicalPath: string;
  link?: string;
  dependentUpon?: string;
  subType?: string;
  condition?: string;
  exists: boolean;
  unresolvedReason?: string;
  isSensitive: boolean;
}
```

Recommended logical tree model:

```ts
export type LegacyTreeNode =
  | ProjectNode
  | FolderNode
  | FileNode
  | WarningNode;

export interface BaseNode {
  id: string;
  label: string;
  children: LegacyTreeNode[];
}

export interface ProjectNode extends BaseNode {
  type: "project";
  projectPath: string;
}

export interface FolderNode extends BaseNode {
  type: "folder";
}

export interface FileNode extends BaseNode {
  type: "file";
  sourcePath?: string;
  logicalPath: string;
  itemKind: ProjectItemKind;
  exists: boolean;
  isSensitive: boolean;
  unresolvedReason?: string;
}

export interface WarningNode extends BaseNode {
  type: "warning";
  message: string;
}
```

---

## Path rules

Use Windows path semantics.

Important rules:

1. Resolve `Include` relative to the `.vbproj` directory
2. Preserve absolute Windows paths
3. Normalize `/` and `\`
4. Use `Link` as the logical display path when present
5. Otherwise use `Include` as the logical display path
6. Never derive the logical tree from the physical source path
7. Detect but do not expand:
   - `$(...)`
   - `@(...)`
   - `%(...)`
   - `*`
   - `?`
8. Mark missing physical files
9. Do not assume all files are under the VS Code workspace root

Use `path.win32` where behavior must be explicitly Windows-oriented.

---

## `DependentUpon` rules

`DependentUpon` contains a file name, usually without the parent folder.

Example:

```xml
<Compile Include="Forms\OrderForm.vb">
  <SubType>Form</SubType>
</Compile>

<Compile Include="Forms\OrderForm.Designer.vb">
  <DependentUpon>OrderForm.vb</DependentUpon>
</Compile>

<EmbeddedResource Include="Forms\OrderForm.resx">
  <DependentUpon>OrderForm.vb</DependentUpon>
</EmbeddedResource>
```

The child must be matched against a parent in the same **logical directory**.

If the child's logical path is:

```text
Forms\OrderForm.Designer.vb
```

and `DependentUpon` is:

```text
OrderForm.vb
```

the parent candidate is:

```text
Forms\OrderForm.vb
```

Use case-insensitive comparison because the target environment is Windows.

If a parent cannot be found:

- Keep the child visible
- Do not discard it
- Optionally show a warning marker

---

## Sensitive file policy

The extension must not claim to completely prevent edits.

For the first prototype:

- Add a warning icon or description
- Show a modal warning when the user opens a sensitive file from this custom tree
- Allow the user to continue after acknowledgement

Candidate sensitive patterns:

- `*.Designer.vb`
- `*.resx`
- `*.settings`
- Items with `AutoGen=True`
- Items with `DesignTime=True`
- Items with `DesignTimeSharedInput=True`
- Items connected to `Generator` or `LastGenOutput`

Do not warn for every `.vb` file.

---

## VS Code view requirements

Create a custom Activity Bar container and Tree View separate from the standard Explorer.

Suggested IDs:

```json
{
  "viewsContainers": {
    "activitybar": [
      {
        "id": "legacyVbWorkbench",
        "title": "Legacy VB",
        "icon": "resources/legacy-vb.svg"
      }
    ]
  },
  "views": {
    "legacyVbWorkbench": [
      {
        "id": "legacyVbWorkbench.projects",
        "name": "VB.NET Projects"
      }
    ]
  }
}
```

Suggested commands:

- `legacyVbWorkbench.selectProject`
- `legacyVbWorkbench.refresh`
- `legacyVbWorkbench.openFile`

Later:

- `legacyVbWorkbench.selectSolution`
- `legacyVbWorkbench.buildSolution`
- `legacyVbWorkbench.openInVisualStudio`
- `legacyVbWorkbench.runExecutable`

---

## Error handling requirements

The tool targets irregular legacy projects. Be defensive.

- Do not use `any`
- Use `unknown` and type guards
- Include the problematic project path in errors
- Preserve partially parsed results where reasonable
- Do not crash the extension because one item is malformed
- Clearly distinguish:
  - Missing file
  - Unsupported expression
  - Unsupported wildcard
  - Conditional item
  - XML parse failure
  - Unsupported item type

Prefer visible diagnostics over silent omission.

---

## Testing strategy

Parser and logical tree tests are more important than UI tests at first.

Create fixtures covering:

1. Normal file
2. Nested relative path
3. `..\..\Shared\File.vb`
4. Absolute path
5. `Link`
6. `DependentUpon`
7. Missing parent
8. Missing physical file
9. `$(Property)` in `Include`
10. Wildcard in `Include`
11. `Condition` on `ItemGroup`
12. `Condition` on an item
13. `Designer.vb`
14. `.resx`
15. `AutoGen`
16. XML namespace
17. UTF-8 BOM

Expected pipeline:

```text
vbproj XML
  -> parsed project items
  -> normalized project items
  -> logical tree
  -> VS Code TreeDataProvider
```

Keep each stage testable independently.

---

## Implementation order

Follow this order unless there is a strong reason not to:

1. Create TypeScript VS Code extension scaffold
2. Implement `parseVbProject`
3. Print parsed items to an Output Channel or JSON
4. Add path normalization
5. Add unresolved-item detection
6. Build logical folder tree
7. Add `DependentUpon`
8. Add Tree View
9. Add click-to-open
10. Add sensitive-file warning
11. Add refresh
12. Test against a real legacy `.vbproj`
13. Only then add `.sln`
14. Only then consider MSBuild execution

---

## Definition of done for the first prototype

The first prototype is complete when it can:

1. Select a real legacy `.vbproj`
2. Display its logical folders and files
3. Display linked files under their `Link` paths
4. Nest `Designer.vb` and `.resx` under the parent form using `DependentUpon`
5. Open the physical file even if it is outside the project folder
6. Mark missing or unresolved items
7. Warn before opening designer-managed files
8. Refresh manually

Do not expand the scope before this works on at least one real project.

---

## Interaction style for this project

When proposing implementation changes:

- Prefer the smallest working increment
- Show exact file names
- Provide complete copy-pasteable code for small files
- Avoid overengineering
- Explain legacy MSBuild limitations plainly
- Do not pretend XML parsing is equivalent to full MSBuild evaluation
- Preserve compatibility with Windows and old Visual Studio projects
- Prefer TypeScript strict mode
- Avoid `any`
- Add tests for parser behavior
- Keep Visual Studio 2013 as a supported companion tool, not an enemy to remove

When uncertain about the actual project structure, request a sanitized `.vbproj` sample or relevant XML fragments before implementing project-specific rules.
