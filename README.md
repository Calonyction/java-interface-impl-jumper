# Java Interface Implementation Jumper

VSCode扩展，用于在Java接口和实现类之间快速跳转，支持查找方法引用。

## 功能

- 从Java接口跳转到其实现类
- 从Java实现类跳转到其接口
- 从Java抽象类跳转到其实现类
- 在每个方法上方显示跳转按钮（CodeLens）
- 查找方法引用功能（Find References）
- 支持 Lombok 字段的 getter/setter 读写引用查询
- 可配置排除文件夹，避免扫描无关目录（如 Local History 历史文件）

## 使用方法

### 方法级别跳转（CodeLens）

在每个方法的上方，会显示一个可点击的链接：

1. 在接口方法上方显示 **Jump to Implementation**，点击可跳转到该方法的实现
2. 在实现类带有 `@Override` 注解的方法上方显示 **Jump to Interface**，点击可跳转到该方法的接口定义
3. 如果启用了Find References功能，在方法上将显示 **Find References** 链接，点击可查找该方法的所有引用

这些链接会直接跳转到对应文件中的具体方法位置，而不仅仅是打开文件。

### 类级别跳转（CodeLens）

1. 在抽象类定义上方显示 **Jump to Implementation**，点击可跳转到该抽象类的具体实现类
2. 如果有多个实现类，会弹出选择框让您选择要跳转的具体实现类

### 查找方法引用（Find References）

启用后，可以：

1. 快速搜索整个工作区中对当前方法的所有引用
2. 精确过滤掉导入语句中的引用
3. 多个引用结果会固定显示在底部 **Java References / Find** 面板中，点击结果可跳转到对应位置

### Lombok 字段读写引用

对于使用 `@Data`、`@Getter` 或 `@Setter` 的类，字段上方会显示：

1. **Find Reads**：查询字段直接读取，以及 `getXxx()` / `isXxx()` 形式的 getter 调用
2. **Find Writes**：查询字段直接赋值，以及 `setXxx(...)` 形式的 setter 调用
3. 在字段名上执行 VSCode 的 “Find All References” 时，也会把 Lombok 生成的 getter/setter 调用纳入结果
4. 多个读写结果会固定显示在底部 **Java References / Find** 面板中

## 特性

- 智能识别方法定义，即使方法定义跨越多行
- 准确处理带有 `@Override` 注解的方法
- 支持带有泛型参数和返回类型的方法
- 支持带有 `throws` 关键字的方法
- 高效的缓存机制，提高跳转速度
- 轻量级实现，不依赖外部Java解析器
- 智能方法引用查找，支持过滤导入语句和接口定义
- Lombok 字段引用查询，支持常见 `@Data` DTO 的 getter/setter 映射
- 优化的日志系统，可根据需要调整日志级别
- 支持自定义排除文件夹，与 Local History 等插件兼容

## 要求

- VSCode 1.60.0 或更高版本
- 打开的工作区必须包含Java文件
- 推荐安装 [Red Hat Java](https://marketplace.visualstudio.com/items?itemName=redhat.java) 扩展以获得更好的 Java 开发体验（非必需）

## 配置选项

在VSCode设置中，可以配置以下选项：

- `javaInterfaceImplJumper.enableCodeLens`: 启用或禁用方法上方的CodeLens功能（默认启用）
- `javaInterfaceImplJumper.enableFindReferences`: 启用或禁用查找方法引用功能（默认禁用；Lombok 字段读写引用不受此开关影响）
- `javaInterfaceImplJumper.excludeFolders`: 搜索Java文件时排除的文件夹列表（默认排除 `node_modules` 和 `.history`）

### 排除文件夹配置示例

在 `settings.json` 中添加：

```json
{
  "javaInterfaceImplJumper.excludeFolders": [
    "node_modules",
    ".history",
    "build",
    "target",
    "out"
  ]
}
```

也可以通过 VSCode 设置 UI 进行配置：`Ctrl+,` -> 搜索 `excludeFolders`

## 已知问题

- 目前仅支持基于文本内容的简单分析，不支持完整的Java语法分析
- 对于复杂的继承关系可能无法正确识别
- 不支持内部类和匿名类
- Lombok 字段查询基于字段名和 JavaBean 访问器命名规则，不支持 `@Accessors` 自定义命名和完整类型推断
- 对于特别大的项目，Find References 功能可能需要较长的处理时间

## 发布说明

### 1.3.0

- 新增 `excludeFolders` 配置项，支持自定义排除文件夹，避免扫描 Local History 等插件生成的历史文件
- 默认排除 `node_modules` 和 `.history` 文件夹
- 修改排除文件夹配置后自动清理缓存，确保搜索结果准确

### 1.2.0

- 添加抽象类跳转到实现类的功能，支持单个和多个实现类的场景
- 在抽象类定义上显示"Jump to Implementation"按钮
- 支持对抽象类的实现类进行快速选择和跳转

### 1.1.0

- 添加"查找方法引用"功能，支持搜索整个工作区中的方法引用
- 改进方法识别算法，支持带有 `throws` 关键字的方法
- 优化引用查找，过滤掉导入语句中的引用
- 添加可配置的日志级别，减少不必要的日志输出
- 修复多个bug，提高功能稳定性
- 改进接口方法识别，增强对复杂泛型和数组返回类型的支持

### 1.0.0

- 初始版本发布
- 实现接口和实现类之间的方法级跳转
- 支持 `@Override` 注解的识别
- 优化方法匹配算法，提高准确性
- 添加缓存机制，提高性能
