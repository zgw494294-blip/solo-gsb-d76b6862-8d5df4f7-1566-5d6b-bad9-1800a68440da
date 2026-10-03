# 透明图层叠序校准台

本地 Web 应用：录入若干个纯色半透明图层与多组「背景色 / 目标色」样本，自动枚举所有底 → 顶叠放顺序，找出对全部样本整体拟合最好的图层顺序，并随最佳叠序一起给出**图层影响诊断**——按底→顶顺序列出每层的有效权重（遮蔽程度），再逐层临时禁用（不透明度置 0）重算误差，量化各层对目标误差的影响；顺序确定后还可以**从目标色反推 1～2 个图层的建议不透明度**；当容差内仍存在多条难分的叠序时，可进一步给出**下一次背景测量建议**——从候选背景中挑出最能把这些顺序的预测色拉开差距的一个；在该候选背景上拿到实测颜色后，还能做**实测颜色复核**——逐条复核容差内的全部叠序哪些仍与测量相符，旧样本不足 4 组时可把测量追加为样本并重新求解；拿到校准台给出的最佳叠序后，还能做**过渡步骤规划**——从当前实际叠序出发，只交换相邻两层，规划一条每一步都合规且旧样本总误差不超过给定上限的最少交换路径；规划成功后可直接**开始执行**，把这条路径变成可逐步确认的调序过程——固定起始叠序、目标、有效上限与全部步骤，逐步确认并把每步叠序写回当前叠序控件，直至全部完成；期间修改输入、手动调整当前叠序或重新规划都会立即终止执行（已确认记录保留、输入不回滚，须重新规划后才能再开始）。此外还能**把当前有效的最佳叠序应用到一张背景图片**：上传一张不超过 2 MiB、宽高各不超过 512 像素的 RGB 模式 PNG，服务端固定该顺序、把每个像素当作背景色逐像素复用同一线性光合成，按现有 HEX 取整规则输出同尺寸 RGB PNG，页面并排展示原图、合成图与所用底→顶顺序，可直接下载。也可以直接**从背景图与叠层实测图的对应像素提取校准样本**：选择两张同尺寸 RGB PNG（各不超过 2 MiB、宽高均不超过 512 像素），在背景图上点选 1～4 个互异位置（缩放显示仍映射回原图像素），页面先展示两图同一像素的原始 RGB 背景 / 目标 HEX 颜色对（不插值、不合成），确认后整批追加到现有样本并重新求解；同批只能追加一次，追加后超过 4 组则整批拒绝。若录入的先后关系形成有向环，求解会在冲突提示旁额外给出一个**待确认的成环解除方案**：找出删去关系对种数最少且剩余无环的一组，经确认后才一次性移除这些关系的全部重复项并重新求解（不会自动修改输入）。

- **后端**：Python + FastAPI（计算核心仅用标准库，便于审阅与测试；图片合成预览使用 Pillow 解码 / 编码 PNG）
- **前端**：原生 HTML / CSS / JavaScript，无任何构建步骤与外部 CDN 依赖
- **色彩管线**：标准 sRGB 分段函数 ↔ 线性光，在线性光空间做 Porter-Duff alpha 合成
- **择优准则**：所有样本、RGB 三通道在 **0–255 未取整** 尺度上的平方误差总和；总误差相同时，按图层 **ID 序列字典序**（反推时按待调参数元组）决胜

## 一条命令启动

需要已安装 Docker（含 Compose 插件）。

```bash
docker compose up --build
```

启动后用浏览器访问：

```
http://localhost:8000
```

停止：在另一个终端执行 `docker compose down`（或 Ctrl+C 后再 `down` 清理容器）。

## 功能说明

| 区域 | 规则 |
| --- | --- |
| 图层 | 2～7 个；ID 必须唯一且非空；颜色支持 `#RGB` / `#RRGGBB`（`#` 可省略，大小写不限）；不透明度 0～1 |
| 样本 | 1～4 组「背景色 + 目标色」；所有样本共用同一底到顶顺序，误差跨样本求和 |
| 先后关系 | 0～12 条「某图层在更下方 / 另一图层在其上方」约束；形成有向环时明确提示冲突链，例如 `A → B → A`，并在提示旁给出**待确认的解除方案**（不自动修改）：在当前图层、样本与至多 12 条关系中找出删去不同关系对**种数最少**、且剩余关系无环的一组（同向重复按一条计、自环必删；每组待删对按 `(lower, upper)` 字典序排序，最少种数并列时取列表字典序最小者）。确认后一次性移除这些对的**全部同向重复项**、保留其他输入并触发原求解；无环时方案为空 |
| 结果 | 最终顺序（带半透明色点、底→顶方向）、总平方误差、枚举/可行排列数；每个样本并排显示目标色与预测色、HEX、RGB 与 R/G/B 分通道平方误差 |
| 图层影响诊断 | 随最佳叠序一起返回、一起更新（不重新择序、不改写输入）：按本次底→顶顺序列出每层**有效权重**（该层不透明度 × 其上各层 (1−不透明度) 的乘积）与**背景权重**（全部层 (1−不透明度) 的乘积），零权重标注「无直接颜色贡献」；再逐层仅把该层不透明度临时设为 0（其余参数与叠序不变），按同一线性光规则重算各样本未取整 RGB 预测、HEX 与平方误差，并给出各样本及总误差的**差值（禁用后 − 原值）**：正值表示该层有助于匹配，负值表示该层增大误差 |
| 不透明度反推 | 顺序确定后，沿用当前图层、样本与先后关系：确认一条底→顶顺序并勾选 1～2 个待调图层，其余图层保留原不透明度。联合遍历待调图层 0.00～1.00、步长 0.01 的全部组合（原始参数组若落在网格外也额外纳入），按同一未取整 RGB 平方误差总和选最优；同分时按 **ID 字典序排列的待调参数元组从小到大** 决胜。页面展示原值 / 建议值、调整前后总误差、每组样本的目标色与调整前后预测色，可一键把建议值写回图层并重新求解 |
| 下一次背景测量建议 | 沿用当前图层、样本与先后关系，录入 **2～12 个**规范化后互不重复的候选背景 HEX 与**非负有限**的误差容差：枚举合规叠序，保留总误差 ≤ 最优总误差 ＋ 容差的顺序，按（总误差、ID 序列）排序取前 12 条展示，并给出符合容差的总数；在每个候选背景上按同一线性光规则渲染这些顺序，以**任意两条预测色未取整 RGB（0–255）平方距离的最小值**给背景打分，推荐得分最高者（同分取规范化 HEX 字典序最小者），并展示推荐背景上最难区分的一对顺序及其预测色；容差内不足两条顺序时提示无需追加测量 |
| 实测颜色复核 | 在建议区选定**一个候选背景**，录入该背景上的**实测目标 HEX** 与**非负有限的新测量误差上限**，沿用当前图层、旧样本、先后关系及建议容差：先保留旧样本总误差 ≤ 最优总误差 ＋ 容差的**全部**合规叠序（建议页只展示前 12 条，但复核逐条覆盖、不会漏），再以选定背景上**未取整 0～255 RGB** 与实测色计算平方误差，仅留下不超过新上限者；显示筛选前后总数，留下叠序展示旧总误差、新测量误差与预测色，按（新测量误差、旧总误差、ID 序列）排序取前 12 条；没有匹配时提示实测与现有候选不相容；有匹配且旧样本少于 4 组时，可把该测量（选定背景＋实测色）追加为第 N＋1 组样本并触发原求解。参与复核的任一输入变化（图层 / 旧样本 / 先后关系 / 候选背景 / 容差 / 选定背景 / 实测色 / 上限）或追加样本后，旧复核结果立即失效，不能再用于追加 |
| 过渡步骤规划 | 录入**当前实际底→顶完整图层 ID 顺序**（必须恰好包含全部图层 ID 各一次，且符合全部先后关系）与**非负有限的过渡总误差上限**；当前顺序在旧样本上的总误差也必须 ≤ 上限，否则按非法输入报错。目标固定为原求解按（总误差、ID 序列）决胜得到的最佳叠序。服务端在「满足先后关系且旧样本未取整 RGB 总平方误差 ≤ 上限」的状态图上以**相邻两层交换**为边做 BFS，求**交换次数最少**的完整路径；并列时按每步交换前两层的 ID 对（下方 ID、上方 ID）组成的序列**字典序**决胜。页面逐步显示所交换图层、交换后叠序、各样本预测色与该步总误差；当前已是目标时返回**空步骤**；目标虽达标（合规且总误差 ≤ 上限）却没有合规路径时明确说明**不可到达**。图层 / 样本 / 先后关系 / 当前顺序 / 上限任一变化后，旧步骤立即失效 |
| 过渡执行（逐步确认调序） | 把一次**有效、可达且已无在途规划请求**的过渡规划变成可逐步确认的执行：点击「开始执行」后固定起始叠序、目标叠序、有效上限与全部步骤，执行面板实时显示**已完成数量（第 k / N 步）、当前实际叠序与下一次交换**；「确认当前一步」把该步交换后的叠序**写回当前实际叠序控件**并推进，余下步骤仍可继续确认，同一步重复确认只计一次；执行期间不能再次开始，全部确认后标记为**已完成**，空路径（当前已是目标，0 步）开始即完成，不可达或已失效的规划不能开始。修改图层、样本、先后关系、过渡上限，手动调整或重置当前叠序，或重新发起规划，都会**立即终止**当前执行：已确认记录保留展示、输入（含已写回的当前叠序）不回滚，即使改回原值也不能续走，须重新规划后才能再开始。执行进度只保存在当前页面内存中，刷新页面即清空（详见「过渡执行的开始、确认与中断」一节） |
| 背景图片合成预览 | 上传一张 **PNG、RGB 模式、不超过 2 MiB、宽高各不超过 512 像素**的背景图片；**只可使用当前校准输入对应的有效求解顺序**——自动重新求解尚未完成、求解失败、连接异常或输入非法时「生成合成预览」禁用（直接调用前端生成函数也不会发送请求），待新求解成功后才可生成。请求固定携带**当前校准输入（layers / samples / relations）与完整底→顶 `order`**（必须恰好包含全部图层各一次并满足全部先后关系），服务端**固定该顺序**——把图片的每个像素当作不透明背景色，逐像素复用现有线性光 "over" 合成，再按现有 HEX 取整规则（clamp 后 `int(round(v×255))`）输出**同尺寸 RGB PNG，不缩放、不重新择序、不改写输入**。页面**并排显示原图、合成图与所用底→顶顺序**，下载链接直接保存为 `composite-preview.png`。图层、样本、关系或图片任一变化（**含清空选择、改回原值**）都会**立即撤销旧预览下载资格与在途合成资格**（改回原值也不恢复）；图片选择的失效发生在选择的第一时间，**不等待图片解码完成**。连续选图 / 生成只接纳「最近一次且相关输入始终未变」的操作，**上传、图片解码或响应体读取期间发生变化也丢弃旧操作**——无论成功、HTTP 错误、连接异常还是解析失败，旧操作均不改动预览、错误提示或较新操作的加载状态；有效操作正常展示结果或错误并结束加载。损坏图片、非 PNG、非 RGB、尺寸越界、文件超限、非法参数均返回明确 400 错误；生成失败不改动任何校准输入 |
| 从图片像素取点追加样本 | 选择**背景图**与**叠层实测图**两张 **PNG、RGB 模式、各不超过 2 MiB、宽高均不超过 512 像素且同尺寸**的图片；仅在**背景图**上点选 **1～4 个互异位置**——浏览器按「点击位置 ÷ 显示尺寸 × 原图像素」映射，缩放显示仍取原图像素（目标图相同坐标同步标记、不可点击）。提交后服务端**直接读取两图同一坐标的原始 8 位 RGB**（不插值、不合成、不缩放），按提交顺序返回坐标及背景 / 目标 HEX 颜色对，页面**先展示颜色对**；确认后把整批颜色对**一次性追加到现有样本**并触发原求解。**同批只能追加一次**；追加后总数超过 4 组则**整批拒绝**（不改动已有样本，减少取点或删除样本后重新提取即可）。**换任一张图（含清空）立即清空全部取点与候选颜色对**；取点或样本（含在其他流程中追加 / 删除样本）变化后，旧颜色对与在途提取结果立即失效、**不能再用于追加**；成功追加沿用输入变更流程：旧自动求解、反推建议与调序执行立即失效（已确认的执行记录保留展示、输入不回滚），并以新样本重新求解。损坏、非 PNG、非 RGB、两图尺寸不符、坐标重复 / 越界 / 非整数 / 数量不为 1～4 均返回明确 400 错误；服务端不保存任何状态 |

输入任意改动后自动重新求解（带防抖），非法颜色、重复 ID、越界不透明度等错误会在页面顶部以中文逐条列出，并暂停计算。反推、背景建议、实测复核与过渡步骤规划均为手动触发；输入变化后，旧结果会在卡片内标记为「可能过期」或「已失效」（反推建议失效后不能再应用，需重新反推，见下节），过渡卡片可随时把当前叠序一键重置为最新最优叠序；进行中的过渡执行也会随输入变化或重置立即终止（见「过渡执行的开始、确认与中断」一节）。

**背景图片合成预览随重新求解联动**：图层、样本或关系每次变化（含清空、改回原值）都会立即触发一次新的自动求解；在新求解成功返回之前，旧求解顺序不再是「当前校准输入对应的有效顺序」，合成按钮保持禁用，无法用旧顺序搭配新输入生成（即便把输入改回原值，也必须等新求解完成）。求解返回业务错误（HTTP 400，输入非法）或连接异常时同样禁用，修正输入后会再次自动求解，成功后按钮自动恢复。选图是另一类「相关输入变化」：清空或换图在选择的第一时间（先于客户端解码）即撤销旧下载与在途合成资格，解码期间再改任何输入 / 图片都会让本次选择整体作废，不会登记文件、不会覆盖错误或加载状态。

先后关系成环时，页面会在顶部冲突提示下方展示「成环 · 待确认解除方案」卡片（随自动求解一起获取，无需手动触发）：只展示方案、**不自动修改**。点击确认后才一次性移除待删关系对的全部同向重复项、保留其他输入并用剩余关系触发原求解。方案卡片遵循与过渡规划同样严格的请求竞态与失效规则（见下节）。

### 成环解除流程的失效与请求竞态规则

原求解（`POST /api/solve`）、解除方案（`POST /api/resolve-cycle`）与确认解除（`POST /api/confirm-cycle-resolution`）三类请求遵循同一套规则：

- **输入纪元**：图层、样本或关系每变化一次，输入纪元就 +1（只增不减）。三类请求发出时各自记录当时的纪元；只有「仍是最新一次、且发出后纪元未变」的请求响应才能落地。输入一经变化，旧请求立即作废，**改回原值也不能让旧请求复活**——纪元不会回到旧值。
- **响应体读取窗口**：响应头到达不等于响应生效。从响应头到达到 JSON 响应体读完之间存在一个窗口，窗口内若修改了图层、样本或关系，或发起了较新请求，旧响应一律作废——守卫在响应体**读完之后**会再次判定，该窗口内的变化同样作数。
- 过期请求无论以**成功、HTTP 错误、连接异常还是响应体解析失败**结束，都会被直接丢弃：不展示方案、不删除关系、不覆盖校准结果、不改错误提示，也不结束较新请求的加载状态。
- 方案只依赖**当前图层、样本和至多 12 条关系**。这三者中任何一个发生变化，已展示方案立即作废、确认按钮禁用；**改回原值也不能恢复确认资格**。
- 确认同样是「待确认」语义：确认请求在途时输入若变化，该确认立即作废，其成功返回也不会修改输入或结果；服务端也会再次校验 `removePairs` 是否恰好等于按当前输入规范化出的最少方案，不一致（多删、少删、选错对或输入已变）一律 400 拒绝。

**失效后如何继续**：输入变化后自动求解会立即按新输入重新发出，若仍成环，新的解除方案会随求解自动重新获取并展示到卡片中，无需手动刷新；待卡片出现与当前输入对应的新方案后，再点击「确认并移除这些关系后重新求解」即可。若确认请求在途期间因输入变化被作废，同样等自动求解带来新方案后重新点击确认。

### 过渡规划的响应失效规则

过渡步骤规划在浏览器端对请求竞态做了严格处理，避免「响应尚未返回时改动输入，旧步骤被当成当前结果」以及「连续规划、响应倒序返回时较早请求覆盖较新结果」：

- 每次点击「规划交换步骤」都会发出一个带**单调递增序号**的请求（序号只增不减，请求以成功、HTTP 错误或连接异常结束后该序号也**不会被后续请求复用**），并记录请求发出时的**参与输入指纹**（图层、样本、先后关系、当前实际叠序、过渡总误差上限）。
- 上述任一参与输入发生变化后，已展示的步骤**立即标记为已失效**；若此时仍有在途请求，该请求（及其响应）**立即作废**，规划区加载状态随即结束。
- 只有**当前在途请求**（即最近发出、尚未被新请求取代、也未因输入变化作废的请求）且其对应输入自发出后**未再变化**的响应才能更新规划：成功则展示新步骤，HTTP 4xx 等业务错误则展示错误信息，二者都会结束加载。
- 输入保持不变时连续规划同样安全：例如先发起两次规划、第二次先返回，再发起第三次——第一次较晚返回的响应不会因为第二次完成而「取回」当前身份，无论它以**成功、HTTP 错误还是连接异常**结束都会被直接丢弃：不覆盖第二次展示的步骤或错误、不提前结束第三次的加载，随后第三次自身返回时也不会被误丢，而是正常展示其步骤或错误并结束加载。
- 一般地，较早请求或已因输入变化而作废的请求，无论其响应是**成功、HTTP 错误还是连接异常**，都会被直接丢弃——不改动当前步骤、不改动错误提示、也不改动加载状态；只要仍有更新的请求在途，加载状态就保持到该请求返回为止。
- 作废后可随时按新输入重新规划；输入先变化后又改回原值的情况，旧请求同样不会复活。

### 过渡执行的开始、确认与中断

过渡执行把一次规划落地为可逐步确认的调序过程（纯前端流程，不新增接口、不改动 `POST /api/plan-transition` 的字段、状态码与算法），规则如下：

- **开始**：仅当当前规划**有效**（未因输入变化失效）、**可达**（含「当前已是目标」的空路径）且**没有规划请求在途**时，「开始执行」才可用。点击后固定起始叠序、目标叠序、有效上限与全部步骤（执行快照不随后续页面变化而改变）。
- **执行中展示**：执行面板实时显示**已完成数量**（第 k / N 步）、**当前实际叠序**（与「当前实际叠序」控件同步）与**下一次交换**（第 k+1 步要交换的相邻两层，先下后上）。
- **确认**：点击「确认当前一步」（或当前步行的「确认此步」）后，把该步交换后的叠序**写回当前实际叠序控件**并推进到下一步；余下的执行步骤仍可继续确认。只能按顺序确认当前步，同一步重复确认只计一次——已确认的步不能再确认。
- **完成**：执行期间不能再次开始；全部步骤确认后执行标记为**已完成**；空路径（0 步）开始即直接完成；不可达或已失效的规划不能开始。
- **中断**：修改图层、样本、先后关系或过渡上限，手动调整或重置当前实际叠序，或重新发起规划，都会**立即终止**当前执行。终止后已确认的记录保留展示、所有输入（含已写回的当前叠序）不回滚；即使把输入改回原值也**不能续走**，必须重新规划并成功落地后才能开始新的执行。
- **进度仅存当前页面**：执行进度只保存在页面内存中，刷新页面即清空，不会持久化。

### 不透明度反推的失效与请求竞态规则

不透明度反推（`POST /api/infer-opacity`）在浏览器端遵循与过渡规划同样严格的规则，避免「请求等待或读取响应期间改动输入，晚到的旧建议被当成当前结果写回图层」，以及「连续反推与应用交替时，新建议 / 旧请求串用彼此的资格」：

- **参与输入**：图层、样本、先后关系、确认的反推顺序、勾选的待调图层。建议生成之后，上述任一输入一旦变化，已展示的建议**立即失效**（卡片内标注、应用按钮禁用）；即使之后**改回原值也不能恢复**应用资格——失效标志一旦置位就不会复位，直接调用「应用」也不会改动任何图层。
- **新建议不沿用旧资格**：一次有效应用之后再修改输入并重新反推，新建议只对它**本次发出时**的那组输入负责；之后哪怕把图层**恢复到上一次应用时的历史值**，新建议也不会因此重新获得应用资格（应用后指纹只锚定当次应用后的状态，且不跨建议继承）。
- **一次有效应用永久作废此前在途的反推**：在已有有效建议时再次发起反推，在**等待响应或读取响应体期间**应用了该建议，随后又把输入**改回请求发出时的值**——那个旧请求仍不会生效：应用时即在途身份被摘除、请求序号也永不复用，其返回一律丢弃，已写回的不透明度、重新求解的结果与「已应用」提示均不被覆盖。
- **请求序号**：每次点击「反推建议不透明度」都发出一个带**单调递增序号**的请求（序号只增不减，请求以任何方式结束后也不会被后续请求复用），并记录发出时的参与输入指纹。只有**当前在途请求**且输入自发出后**未再变化**、且未被一次有效应用作废的响应才能落地：成功则展示建议，HTTP 400 等业务错误则展示错误信息，二者都会结束加载。
- **响应体读取窗口**：响应头到达不等于响应生效。守卫在响应体**读完之后**会再次判定，读取窗口内发生的输入变化、较新请求或一次有效应用同样作数。
- 连续反推只接纳最近发起且输入未变（且未被应用作废）的请求：较早请求无论以**成功、HTTP 错误、连接异常还是解析失败**结束，都会被直接丢弃——不更新反推建议、不改动错误提示、也不提前结束较新请求的加载状态；有效的最新反推正常展示建议或错误并结束加载。
- 「应用建议值回图层并重新求解」在点击时**再次核对资格**：建议已失效则不改任何图层；有效应用按原规则把建议不透明度写回图层并触发原求解，卡片保留「已应用」提示，同时立即作废此前所有在途反推（见上）。

**失效后如何继续**：建议失效后无需手动清理，按当前输入重新点击「反推建议不透明度」，待卡片展示与当前输入对应的新建议后，再点击「应用建议值回图层并重新求解」即可。

### 合成预览的重新求解与请求竞态规则

背景图片合成预览（`POST /api/composite-preview`）的下载资格、生成按钮与在途请求在浏览器端受**合成纪元**与**单调请求序号**双重控制，规则与反推 / 过渡同样严格：

- **有效求解顺序（重新求解联动）**：每次成功的自动求解都会锚定到当时的**求解输入纪元**。生成只可使用锚定纪元等于当前纪元的顺序；输入变化后新求解**尚未取得结果、求解失败（HTTP 400 输入非法）或连接异常**时，合成按钮禁用且提示原因，直接调用前端生成函数也不会发出任何请求。输入改回原值同样不会让旧求解顺序提前复活——必须等该输入下的新求解成功。
- **合成纪元**：图层、样本、关系（与求解输入纪元同步）或已选背景图片每次变化（**含清空选择、改回原值**）都让合成纪元 +1，只增不减。变化发生的**第一时间**（图片选择先于解码、输入变化先于防抖求解）旧预览的下载链接立即变为不可点击、在途合成立即失去落地资格并结束自身加载态；即使之后把输入或图片改回原值也不恢复。
- **连续选图 / 生成**：每次生成从**永不归零**的单调计数器取得请求序号；只有「最近一次、且相关输入自发出后始终未变」的操作可以落地。上传（fetch 等待）、图片解码（`resp.blob()` 等响应体读取）期间若图层 / 样本 / 关系 / 图片发生变化或出现了较新操作，旧操作一律作废。
- 过期操作无论以**成功、HTTP 错误、连接异常还是响应体解析失败**结束，都被直接丢弃：不替换预览图、不改写错误提示、也不结束较新操作的加载状态；**有效的**最新操作正常展示合成结果或错误信息并结束加载。
- 服务端不保存、不改写任何校准输入：合成成功返回 `200 image/png`，校验失败返回 400 JSON（字段、状态码、图片限制与「固定顺序合成、不重新择序」规则均见上文 API 一节）。

**失效后如何继续**：校准输入变化后等待自动重新求解成功（顶部状态清空、校准结果刷新），合成按钮即自动恢复；图片相关变化后重新选择一张通过客户端预检的 PNG，再点击「生成合成预览」即可。

### 色彩与合成细节

1. HEX → sRGB(0～1)；按 IEC 61966-2-1 分段函数转为线性光：
   - `c ≤ 0.04045`：`c / 12.92`
   - 否则：`((c + 0.055) / 1.055) ** 2.4`
2. 以不透明背景色（α=1）打底，按底到顶顺序逐层做 "over" 合成（预乘形式）。
3. 结果经逆函数转回 sRGB，误差比较使用未四舍五入的浮点 RGB × 255 值；页面上的预测 HEX 才是取整后的值。
4. 对 7 个图层最多枚举 7! = 5040 个排列，逐排列过滤约束并评估，响应为毫秒级。

## API

`POST /api/solve`

```json
{
  "layers": [
    { "id": "R", "color": "#ff0000", "opacity": 0.5 },
    { "id": "B", "color": "#0000ff", "opacity": 0.5 }
  ],
  "samples": [
    { "background": "#ffffff", "target": "#e189bc" }
  ],
  "relations": [
    { "lower": "R", "upper": "B" }
  ]
}
```

成功返回 `order`（底→顶 ID 序列）、`orderIndexes`、`layers`（同序）、`totalSse`、`permutationsChecked`、`feasibleCount`、每个样本的 `target / predictedHex / predictedRgb / channelSse / sse`，以及随求解一起更新的 `diagnosis` 图层影响诊断（见下）。

#### 图层影响诊断（`diagnosis`）

诊断基于本次选定的底→顶顺序计算，**不重新择序、不改写输入**：

- `layers[i].weight`：底→顶第 i 层的**有效权重** ＝ 该层不透明度 × 其上各层 (1−不透明度) 的乘积；`backgroundWeight`：**背景权重** ＝ 全部层 (1−不透明度) 的乘积。线性光 "over" 合成下，未取整预测色正是背景色与各层颜色按这些权重的加权和（全部权重之和为 1）；权重为 0 表示被完全遮蔽，**无直接颜色贡献**（页面会专门标注）。
- `layers[i].totalSse` / `layers[i].samples`：**仅把该层不透明度临时设为 0**（其余参数与叠序不变）后，按同一线性光规则重算的总误差与各样本未取整 RGB 预测值、HEX、分通道平方误差（样本子结构与 `/api/solve` 的 `samples` 一致）。
- `layers[i].totalDelta` / `layers[i].samples[j].sseDelta`：**差值 ＝ 禁用后 − 原值**。正值表示禁用后误差变大、即该层原本有助于匹配；负值表示该层反而增大误差。

上面示例请求（`R` 在 `B` 下方，唯一可行顺序为 `["R", "B"]`，`totalSse = 2745.3695`）返回的诊断为：

```json
"diagnosis": {
  "backgroundWeight": 0.25,
  "layers": [
    {
      "id": "R", "index": 0, "position": 0, "opacity": 0.5, "weight": 0.25,
      "totalSse": 8445.9173, "totalDelta": 5700.5478,
      "samples": [
        { "index": 0, "background": "#ffffff", "target": "#e189bc",
          "predictedRgb": [187.52, 187.52, 255.0], "predictedHex": "#bcbcff",
          "targetRgb": [225.0, 137.0, 188.0],
          "channelSse": [1405.05, 2551.87, 4489.0],
          "sse": 8445.9173, "sseDelta": 5700.5478 }
      ]
    },
    {
      "id": "B", "index": 1, "position": 1, "opacity": 0.5, "weight": 0.5,
      "totalSse": 3452.1036, "totalDelta": 706.7341,
      "samples": [
        { "index": 0, "background": "#ffffff", "target": "#e189bc",
          "predictedRgb": [255.0, 187.52, 187.52], "predictedHex": "#ffbcbc",
          "targetRgb": [225.0, 137.0, 188.0],
          "channelSse": [900.0, 2551.87, 0.23],
          "sse": 3452.1036, "sseDelta": 706.7341 }
      ]
    }
  ]
}
```

读法：底层 `R`（α=0.5）被上层 `B`（α=0.5）遮住一半，有效权重 0.5 × (1−0.5) = 0.25；顶层 `B` 上方无遮挡，有效权重 0.5；背景权重 (1−0.5)² = 0.25。禁用 `R` 后总误差从 2745.3695 升至 8445.9173（`totalDelta = +5700.5478`），说明 `R` 有助于匹配；禁用 `B` 后升至 3452.1036（`+706.7341`），同样有助，但贡献小于 `R`。若某层差值为负，则说明去掉它反而更准——该层在增大误差。

输入非法或约束成环时返回 HTTP 400：

```json
{ "errors": [ { "scope": "layers", "index": 0, "message": "不透明度越界：1.2，必须在 0～1 之间" } ] }
```

`scope` 取值为 `layers` / `samples` / `relations` / `form`。

### `POST /api/infer-opacity` — 不透明度反推

在已有图层、样本与先后关系不变的前提下，显式给出一条底→顶 `order`（必须**恰好包含全部图层 ID 且各一次**，并满足全部先后关系），再给出 `adjustIds`（**1～2 个**已存在、不重复的图层 ID，服务端按 ID 字典序排列作为参数元组序）。其余图层保留输入中的原不透明度。

```bash
curl -s -X POST http://localhost:8000/api/infer-opacity \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [
      { "lower": "R", "upper": "B" }
    ],
    "order": ["R", "B"],
    "adjustIds": ["R", "B"]
  }'
```

成功返回（节选）：

```json
{
  "order": ["R", "B"],
  "orderIndexes": [0, 1],
  "adjustIds": ["B", "R"],
  "layers": [
    { "id": "R", "color": "#ff0000", "opacity": 0.5 },
    { "id": "B", "color": "#0000ff", "opacity": 0.5 }
  ],
  "adjustments": [
    { "id": "B", "index": 1, "originalOpacity": 0.5, "suggestedOpacity": 0.25 },
    { "id": "R", "index": 0, "originalOpacity": 0.5, "suggestedOpacity": 0.67 }
  ],
  "beforeTotalSse": 2745.3695,
  "afterTotalSse": 1.4198,
  "beforeSamples": [
    { "index": 0, "background": "#ffffff", "target": "#e189bc",
      "predictedHex": "#bc89e1", "predictedRgb": [187.52, 136.96, 224.61],
      "channelSse": [1405.05, 0.0, 1340.32], "sse": 2745.3695 }
  ],
  "afterSamples": [
    { "index": 0, "background": "#ffffff", "target": "#e189bc",
      "predictedHex": "#e188bb", "predictedRgb": [224.61, 136.33, 187.10],
      "channelSse": [0.15, 0.45, 0.82], "sse": 1.4198 }
  ],
  "combosChecked": 10201,
  "opacityGrid": { "min": 0.0, "max": 1.0, "step": 0.01 }
}
```

说明：

- 遍历组合数为 101（调 1 个）或 101² = 10201（调 2 个）；当原始参数组不在 0.01 网格上（如 0.333）时，会把这一个原始元组**额外**纳入评估，`combosChecked` 相应 +1，以保证建议不会差于原值。若原始元组本身最优，建议值就等于原值，页面标注「原值即最优」；应用回图层后与页面预测逐位一致。
- `beforeSamples` / `afterSamples` 结构与 `/api/solve` 的 `samples` 一致（`target / predictedHex / predictedRgb / channelSse / sse`），分别对应调整前、后的预测。
- 同分决胜：按 `adjustIds` 字典序排列的待调参数元组从小到大（如 `(0.0, 0.3)` 优于 `(0.0, 0.4)`，`(0.1, 0.0)` 优于 `(0.2, 0.0)`）。
- 典型 400 报错（HTTP 状态码仍为 400，`scope` 为 `order` / `adjust`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "order",  "message": "order 必须恰好包含全部 3 个图层 ID（各一次），当前 2 个" },
  { "scope": "order",  "message": "order 中图层 ID 重复：R，每个图层必须且只能出现一次" },
  { "scope": "order",  "message": "所给顺序不符合先后关系：R 必须在 B 下方（底 → 顶）" },
  { "scope": "adjust", "message": "待调图层 ID 重复：R，同一图层只能选择一次" },
  { "scope": "adjust", "message": "待调图层 ID 不存在：'X'" }
] }
```

### `POST /api/suggest-background` — 下一次背景测量建议

在 `/api/solve` 请求体的基础上增加两个字段，其余字段（`layers` / `samples` / `relations`）含义与校验完全沿用：

- `candidateBackgrounds`：**2～12 个**候选背景 HEX（`#RGB` / `#RRGGBB`，`#` 可省略），**规范化后互不重复**；
- `tolerance`：**非负有限**数字的误差容差。

服务端枚举合规叠序，保留总误差 ≤ 最优总误差 ＋ 容差的顺序，按（总误差、ID 序列）排序取前 12 条；再在每个候选背景上按同一线性光规则渲染这些顺序，以任意两条预测色**未取整 RGB（0–255 尺度）平方距离的最小值**给背景打分，推荐得分最高者（同分取规范化 HEX 字典序最小者）。

```bash
curl -s -X POST http://localhost:8000/api/suggest-background \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [],
    "candidateBackgrounds": ["#ffffff", "#000000", "#808080"],
    "tolerance": 10000
  }'
```

成功返回（节选）：

```json
{
  "tolerance": 10000.0,
  "bestSse": 0.3876,
  "feasibleCount": 2,
  "withinCount": 2,
  "orders": [
    { "order": ["B", "R"], "orderIndexes": [1, 0], "totalSse": 0.3876 },
    { "order": ["R", "B"], "orderIndexes": [0, 1], "totalSse": 2745.3695 }
  ],
  "needsMeasurement": true,
  "candidates": [
    { "hex": "#ffffff", "score": 2751.9816,
      "pair": { "a": { "order": ["B", "R"], "predictedHex": "#e189bc",
                       "predictedRgb": [224.61, 136.96, 187.52] },
                "b": { "order": ["R", "B"], "predictedHex": "#bc89e1",
                       "predictedRgb": [187.52, 136.96, 224.61] } } },
    { "hex": "#000000", "score": 5111.7888, "pair": { "a": "…", "b": "…" } },
    { "hex": "#808080", "score": 4331.6991, "pair": { "a": "…", "b": "…" } }
  ],
  "recommended": { "hex": "#000000", "score": 5111.7888, "pair": { "a": "…", "b": "…" } }
}
```

说明：

- `withinCount` 为符合容差的叠序总数（可能多于 12），`orders` 只含排序后的前 12 条；`bestSse` 与 `/api/solve` 的 `totalSse` 逐位一致。
- `needsMeasurement` 为 `false`（容差内不足两条顺序）时，`candidates` 为空、`recommended` 为 `null`，表示当前样本已能唯一区分叠序，无需追加测量。
- 每个候选背景的 `pair` 是得分来源——该背景上最难区分的一对顺序及其未取整预测色（`predictedRgb` 为 0–255 浮点，`predictedHex` 为取整后的展示值）；`recommended` 是得分最高的候选，同分时取规范化 HEX 字典序最小者。
- 典型 400 报错（`scope` 为 `candidates` / `tolerance`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "candidates", "index": 1, "message": "候选背景色重复：#ffffff（与第 1 个规范化后相同）" },
  { "scope": "candidates", "index": 2, "message": "候选背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 '#gg0000'" },
  { "scope": "candidates", "message": "候选背景数量必须在 2～12 个之间，当前 1 个" },
  { "scope": "tolerance",  "message": "误差容差不能为负：-1" },
  { "scope": "tolerance",  "message": "误差容差必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/review-measurement` — 实测颜色复核

在 `/api/suggest-background` 请求体的基础上增加三个复核字段（`candidateBackgrounds` / `tolerance` 仍沿用建议区的录入）：

- `selectedBackground`：从候选背景中选定的**一个**背景 HEX（规范化后必须存在于 `candidateBackgrounds`）；
- `measuredColor`：在该背景上测得的目标色 HEX（`#RGB` / `#RRGGBB`，`#` 可省略）；
- `measurementLimit`：**非负有限**数字的新测量误差上限。

服务端先枚举旧样本总误差 ≤ 最优总误差 ＋ 容差的**全部**合规叠序（不按前 12 条截断），再在选定背景上以未取整 0–255 RGB 与实测色计算平方误差，仅保留不超过 `measurementLimit` 的叠序；留下的叠序按（新测量误差、旧总误差、ID 序列字典序）排序，仅前 12 条进入 `orders`，但 `matchedCount` 是覆盖全部叠序筛选后的真实总数。

```bash
curl -s -X POST http://localhost:8000/api/review-measurement \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [],
    "candidateBackgrounds": ["#ffffff", "#000000", "#808080"],
    "tolerance": 10000,
    "selectedBackground": "#ffffff",
    "measuredColor": "#e289bb",
    "measurementLimit": 5
  }'
```

成功返回：

```json
{
  "tolerance": 10000.0,
  "measurementLimit": 5.0,
  "selectedBackground": "#ffffff",
  "measuredColor": "#e289bb",
  "bestSse": 0.3876,
  "feasibleCount": 2,
  "withinCount": 2,
  "matchedCount": 1,
  "compatible": true,
  "shownCount": 1,
  "orders": [
    {
      "order": ["B", "R"],
      "orderIndexes": [1, 0],
      "oldTotalSse": 0.3876,
      "measurementSse": 0.4521,
      "predictedRgb": [224.61, 136.96, 187.52],
      "predictedHex": "#e189bc",
      "channelSse": [0.15, 0.0, 0.30]
    }
  ],
  "sampleCount": 1,
  "canAppendSample": true
}
```

说明：

- `feasibleCount` 为满足先后关系的叠序总数，`withinCount` 为其中旧总误差 ≤ 最优总误差 ＋ 容差者（**筛选前**），`matchedCount` 为再按新测量误差上限筛选后的数量（**筛选后**）；`orders` 只有排序后的前 12 条，`shownCount` 为本次实际返回条数。
- 每条结果给出 `oldTotalSse`（旧样本总误差，与 `/api/solve` 的 `totalSse` 同口径）、`measurementSse`（选定背景上未取整 RGB 对实测色的平方误差）、`predictedRgb`（0–255 浮点）与取整展示用 `predictedHex`。
- `compatible` 为 `false`（即 `matchedCount = 0`）时，`orders` 为空，表示实测色与现有候选不相容。
- `canAppendSample`：有匹配且旧样本少于 4 组时为 `true`。追加样本由客户端完成——把 `{ "background": selectedBackground, "target": measuredColor }` 加入 `samples` 后重新调用 `/api/solve` 即「触发原求解」；追加后旧复核结果立即失效，不能再用同一次结果重复追加。
- 典型 400 报错（新增错误的 `scope` 为 `review`，容差等沿用 `tolerance` 等原 scope）：

```json
{ "errors": [
  { "scope": "review", "message": "请从候选背景中选择一个用于复核的背景" },
  { "scope": "review", "message": "选定的复核背景 #123456 不在候选背景列表中，请先在建议区选择一个候选背景" },
  { "scope": "review", "message": "选定的复核背景色非法：需要形如 #RRGGBB 的 HEX 值，实际为 'zzz'" },
  { "scope": "review", "message": "实测目标色非法：需要形如 #RRGGBB 的 HEX 值，实际为 '#gg0000'" },
  { "scope": "review", "message": "新测量误差上限不能为负：-1" },
  { "scope": "review", "message": "新测量误差上限必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/plan-transition` — 过渡步骤规划

在 `/api/solve` 请求体（`layers` / `samples` / `relations`，校验完全沿用）的基础上增加两个字段：

- `currentOrder`：**当前实际底→顶的完整图层 ID 顺序**，必须恰好包含全部图层 ID（各一次），且符合全部先后关系，并且其旧样本总误差 ≤ 上限；
- `transitionLimit`：**非负有限**数字的过渡总误差上限。

目标叠序不需要传入——服务端按原求解规则（未取整 RGB 总平方误差，同分按 ID 序列字典序）枚举得到，即与 `/api/solve` 的 `order` 逐位一致。规划时把每个满足先后关系且旧样本总误差 ≤ 上限的叠序视为一个可达节点，相邻两层交换（交换后仍合规）视为一条边：BFS 求交换次数最少的路径；每个节点的候选交换按交换前「下方图层 ID、上方图层 ID」对的字典序展开，因此并列最短路径中返回的是**每步交换 ID 对序列字典序最小**的一条。

```bash
curl -s -X POST http://localhost:8000/api/plan-transition \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "G", "color": "#00ff00", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" },
      { "background": "#000000", "target": "#204060" }
    ],
    "relations": [],
    "currentOrder": ["B", "R", "G"],
    "transitionLimit": 1000000000
  }'
```

成功返回（节选）：

```json
{
  "transitionLimit": 1000000000.0,
  "currentOrder": ["B", "R", "G"],
  "currentOrderIndexes": [2, 0, 1],
  "currentTotalSse": 37439.0488,
  "currentSamples": [{ "…与 /api/solve 的 samples 同结构…" }],
  "targetOrder": ["G", "R", "B"],
  "targetOrderIndexes": [1, 0, 2],
  "targetTotalSse": 24619.8264,
  "targetSamples": [{ "…" }],
  "bestSse": 24619.8264,
  "feasibleCount": 6,
  "allowedCount": 6,
  "alreadyTarget": false,
  "reachable": true,
  "stepCount": 3,
  "statesVisited": 6,
  "steps": [
    {
      "step": 1,
      "swapIndex": 0,
      "swappedLowerId": "B",
      "swappedUpperId": "R",
      "pair": ["B", "R"],
      "order": ["R", "B", "G"],
      "orderIndexes": [0, 2, 1],
      "totalSse": 34647.5773,
      "samples": [{ "…交换后各样本的预测色与分通道误差…" }]
    }
  ]
}
```

说明：

- 每个 `steps[i]` 描述**第 i 步交换之后**的状态：`swapIndex` 是交换前下方图层所在的底→顶位置（0 起），`pair` / `swappedLowerId` / `swappedUpperId` 是交换前相邻两层的 ID（先下后上，也是字典序决胜的比较单元），`order` 是交换后的完整叠序，`totalSse` 与 `samples`（`target / predictedHex / predictedRgb / targetRgb / channelSse / sse`）按现有线性光规则在旧样本上计算，未取整 RGB 总平方误差保证 ≤ `transitionLimit`。
- `currentSamples` / `targetSamples` 分别给出起点（第 0 步，未交换）与目标的逐样本明细；`feasibleCount` 是满足先后关系的叠序总数，`allowedCount` 是其中总误差 ≤ 上限的可停留状态数，`statesVisited` 是本次 BFS 实际访问的状态数。
- 当前实际叠序已经是目标时，HTTP 200 且 `alreadyTarget = true`、`steps = []`、`stepCount = 0`。
- 目标叠序本身合规且总误差 ≤ 上限，但合规子图中不存在从当前叠序到它的相邻交换路径时（例如当前叠序的任一相邻交换都会突破上限），HTTP 200 且 `reachable = false`、`steps = []`，并在 `message` 中给出中文说明。
- 非法顺序（缺漏 / 重复 / 不存在的 ID、不符合先后关系）、当前顺序总误差超过上限、上限为负或非有限数字等情况返回 HTTP 400（新增错误 `scope` 为 `transition`，其余校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "transition", "message": "currentOrder 必须恰好包含全部 3 个图层 ID（各一次），当前 2 个" },
  { "scope": "transition", "message": "currentOrder 中图层 ID 重复：R，每个图层必须且只能出现一次" },
  { "scope": "transition", "message": "currentOrder 中的图层 ID 不存在：'X'" },
  { "scope": "transition", "message": "当前顺序不符合先后关系：R 必须在 G 下方（底 → 顶）" },
  { "scope": "transition", "message": "当前顺序的旧样本总误差 37439 已超过过渡总误差上限 100，请放宽上限" },
  { "scope": "transition", "message": "过渡总误差上限不能为负：-1" },
  { "scope": "transition", "message": "过渡总误差上限必须是非负有限的数字，实际为 'abc'" }
] }
```

### `POST /api/resolve-cycle` — 成环解除方案（待确认）

请求体与 `/api/solve` 完全相同（`layers` / `samples` / `relations`，校验完全沿用）。服务端在当前图层、样本与至多 12 条关系（同向重复按一条规范化去重）构成的有向图上判环：

- 无环时返回空方案：`"cyclic": false`、`"removePairs": []`；
- 成环时返回冲突链（与 `/api/solve` 成环报错同口径）与一组待删关系对：删去不同关系对的**种数最少**且剩余无环；自环必删；每组待删对按 `(lower, upper)` 字典序排序，最少种数并列时取**列表字典序最小**者；
- 其他非法输入（图层数越界、非法颜色、重复 ID、关系引用不存在等）仍按现有规则返回 400。

注意该接口**只给出方案、不修改任何输入**；真正移除由下方的确认接口完成。

```bash
curl -s -X POST http://localhost:8000/api/resolve-cycle \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [
      { "lower": "R", "upper": "B" },
      { "lower": "B", "upper": "R" },
      { "lower": "R", "upper": "B" }
    ]
  }'
```

成环时返回：

```json
{
  "cyclic": true,
  "conflictChain": "R → B → R",
  "relationCount": 2,
  "removePairs": [
    { "lower": "R", "upper": "B", "selfLoop": false, "occurrences": 2 }
  ],
  "removeCount": 1,
  "removedOccurrences": 2
}
```

无环时返回：

```json
{
  "cyclic": false,
  "conflictChain": "",
  "relationCount": 1,
  "removePairs": [],
  "removeCount": 0,
  "removedOccurrences": 0
}
```

说明：

- `removePairs[].occurrences` 是该规范化关系对在原始 `relations`（截断至 12 条后）中的出现次数；同向重复在方案里**只算一种**，确认时这些重复项会一并移除，`removedOccurrences` 是实际移除的输入条数。
- `selfLoop: true` 表示自环（`lower == upper`），自环在任何拓扑序下都无法满足，因此方案必含全部自环。
- 关系本身的其他非法情形（超过 12 条、引用不存在的图层 ID、字段格式错误等）仍按原 `/api/solve` 的 400 规则报错，不会给出方案。

### `POST /api/confirm-cycle-resolution` — 确认解除并触发原求解

在 `/api/resolve-cycle` 请求体基础上增加 `removePairs`（只需列**规范化后的不同关系对**，每种一对，不要按重复次数重复列出）：

- 服务端重新解析当前输入并计算规范化最少方案；`removePairs` 必须与它**完全一致**（多删、少删、选错对、含重复项均拒绝）——图层、样本或关系一旦变化（哪怕改回原值），旧方案即失去确认资格，需重新调用 `/api/resolve-cycle`；
- 校验通过后，服务端一次性从原始 `relations` 中移除这些对的**全部同向重复项**（按规范化 ID 匹配），保留其余全部输入，再执行与 `/api/solve` **完全相同**的求解，返回内容结构也与 `/api/solve` 逐字段一致。

```bash
curl -s -X POST http://localhost:8000/api/confirm-cycle-resolution \
  -H "Content-Type: application/json" \
  -d '{
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [
      { "lower": "R", "upper": "B" },
      { "lower": "B", "upper": "R" },
      { "lower": "R", "upper": "B" }
    ],
    "removePairs": [
      { "lower": "R", "upper": "B" }
    ]
  }'
```

返回即原求解结果（上例中 `R → B` 的 2 条重复输入被一并移除，仅剩 `B 在 R 下方`，故最优顺序为 `["B", "R"]`）：

```json
{
  "order": ["B", "R"],
  "orderIndexes": [1, 0],
  "totalSse": 0.3876,
  "permutationsChecked": 2,
  "feasibleCount": 1,
  "samples": [ { "…与 /api/solve 完全一致…" } ]
}
```

说明：

- 当前输入无环时，唯一合法的 `removePairs` 是空数组 `[]`，此时等同于 `/api/solve`；无环却提交非空方案会被 400 拒绝。
- 方案失效、`removePairs` 缺失 / 格式错误、引用不存在的图层 ID、同对重复列出等情况返回 HTTP 400（新增错误 `scope` 为 `cycleResolution`，图层 / 样本 / 关系等校验错误沿用原 scope）：

```json
{ "errors": [
  { "scope": "cycleResolution", "message": "解除方案已失效：图层、样本或关系已发生变化，请重新获取当前方案后再确认" },
  { "scope": "cycleResolution", "message": "缺少 removePairs 列表或其格式不正确：应为待删除关系对数组" },
  { "scope": "cycleResolution", "message": "待删除关系的下方图层 ID 不存在：'X'" },
  { "scope": "cycleResolution", "message": "待删除关系对重复：R → B（同向重复只需列一次）" }
] }
```

### `POST /api/composite-preview` — 背景图片合成预览（multipart 上传）

把当前有效的最佳叠序固定下来应用到一张背景图片上。请求为 **`multipart/form-data`**，含两个表单字段：

- `payload`：JSON 文本，内容为当前校准输入（`layers` / `samples` / `relations`，校验完全沿用 `/api/solve`）外加完整的底→顶 `order`——必须**恰好包含全部图层 ID 各一次**并**满足全部先后关系**；服务端固定该顺序逐像素合成，**不重新择序、不改写输入**。
- `image`：背景图片文件，必须是 **PNG、RGB 模式、不超过 2 MiB、宽、高各不超过 512 像素**。服务端不缩放；输出与输入**同尺寸 RGB PNG**。

合成规则：把每个像素的 8 位 RGB 经现有 sRGB 分段函数转为线性光当作不透明背景（α=1），按 `order` 逐层复用现有线性光 "over" 合成，转回 sRGB 后按现有 HEX 取整规则（clamp 到 0～1 后 `int(round(v×255))`）输出整 8 位通道——与样本预测 HEX 的取整口径逐位一致（随机图像逐像素对比，零像素差异）。

curl 上传调用示例（`-F image=@图片路径` 发送文件，`-F payload=...` 发送 JSON 文本）：

```bash
# 1) 先准备一张符合限制的 RGB PNG（≤2 MiB、宽高 ≤512），例如 background.png
# 2) 用当前校准输入与 /api/solve 返回的 order（示例最优顺序为 ["B","R"]）合成：
curl -s -X POST http://localhost:8000/api/composite-preview \
  -F 'payload={
    "layers": [
      { "id": "R", "color": "#ff0000", "opacity": 0.5 },
      { "id": "B", "color": "#0000ff", "opacity": 0.5 }
    ],
    "samples": [
      { "background": "#ffffff", "target": "#e189bc" }
    ],
    "relations": [],
    "order": ["B", "R"]
  };type=application/json' \
  -F 'image=@background.png;type=image/png' \
  -OJ
```

> `-OJ`（curl 7.76+）按服务端 `Content-Disposition: attachment; filename="composite-preview.png"` 直接以该文件名保存；旧版 curl 可改用 `-o composite-preview.png`。页面端则直接把返回的 PNG 显示为可点击下载的合成图。

成功时响应为 `200 image/png`（附件下载，体即同尺寸合成 PNG），并附三个自定义响应头便于页面展示：`X-Composite-Order`（回显底→顶顺序的 JSON 数组）、`X-Composite-Width`、`X-Composite-Height`。

校验失败返回 HTTP 400 JSON（与其他接口同一错误结构），`scope` 为 `image` / `order` / `form`（图层、样本、关系等沿用原 scope）：

```json
{ "errors": [
  { "scope": "image", "message": "缺少背景图片文件：请通过 multipart 表单字段 image 上传一张 PNG 图片" },
  { "scope": "image", "message": "图片体积超出 2 MiB（2097152 字节）上限，请压缩或裁剪后重试" },
  { "scope": "image", "message": "图片已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片" },
  { "scope": "image", "message": "图片格式必须是 PNG，实际为 JPEG（不接受 JPEG / GIF / WebP 等）" },
  { "scope": "image", "message": "图片必须是 RGB 模式 PNG，实际为 RGBA 模式（请先转换为 RGB，不接受索引色 / RGBA / 灰度 / 黑白）" },
  { "scope": "image", "message": "图片尺寸 768×512 超出上限：宽、高均不得超过 512 像素（服务端不会缩放，请自行裁剪）" },
  { "scope": "order", "message": "order 必须恰好包含全部 2 个图层 ID（各一次），当前 1 个" },
  { "scope": "order", "message": "order 中图层 ID 重复：R，每个图层必须且只能出现一次" },
  { "scope": "order", "message": "所给顺序不符合先后关系：R 必须在 B 下方（底 → 顶）" },
  { "scope": "form",  "message": "缺少 payload 表单字段：应为包含当前校准输入与 order 的 JSON 文本" },
  { "scope": "form",  "message": "payload 字段不是合法的 JSON" }
] }
```

**失效与请求竞态**：该接口只负责「固定输入 + 固定顺序 + 一张图」的一次性合成；下载资格完全由页面端纪元 / 请求序号控制——图层、样本、关系或图片一经变化（含改回原值），旧合成预览立即失去下载资格；连续生成时仅最近一次、且上传与响应体读取期间输入未变的请求可以落地，其余旧结果无论成功或失败都被丢弃。无论合成成功还是返回 400，服务端都不保存、不改写任何校准输入。

### `POST /api/pick-samples` — 从两图对应像素提取颜色对（multipart 上传）

输入**两张同尺寸 RGB PNG**与**一组零基整数坐标**，服务端直接读取两图同一像素的原始 RGB，按提交顺序返回背景 / 目标 HEX。请求为 **`multipart/form-data`**，含三个表单字段：

- `background`：**背景图**文件，必须是 **PNG、RGB 模式、不超过 2 MiB、宽、高各不超过 512 像素**；
- `target`：**叠层实测图**文件，限制与背景图相同，且必须与背景图**同尺寸**；
- `payload`：JSON 文本，形如 `{"points": [{"x": 0, "y": 0}, ...]}`。坐标以**左上角为原点、零基整数**，数量 **1～4 个**且**互异、不越界**（不接受小数 / 布尔 / 负数）。

服务端**不做任何插值、合成或缩放**：返回的就是两图解码后该坐标像素的原始 8 位 RGB 与对应 HEX；服务端不保存任何状态、不改动校准输入。

curl 调用示例（`-F background=@背景图 -F target=@实测图` 发送两张图片，`-F payload=...` 发送坐标 JSON）：

```bash
# 准备两张同尺寸 RGB PNG（≤2 MiB、宽高 ≤512）：background.png 与 measured.png
curl -s -X POST http://localhost:8000/api/pick-samples \
  -F 'payload={"points":[{"x":10,"y":20},{"x":120,"y":240}]};type=application/json' \
  -F 'background=@background.png;type=image/png' \
  -F 'target=@measured.png;type=image/png'
```

成功返回 HTTP 200 JSON（坐标与颜色按提交顺序排列）：

```json
{
  "width": 256,
  "height": 256,
  "pointCount": 2,
  "pairs": [
    { "index": 0, "x": 10, "y": 20,
      "backgroundRgb": [255, 255, 255], "targetRgb": [225, 137, 188],
      "backgroundHex": "#ffffff", "targetHex": "#e189bc" },
    { "index": 1, "x": 120, "y": 240,
      "backgroundRgb": [0, 0, 0], "targetRgb": [32, 64, 96],
      "backgroundHex": "#000000", "targetHex": "#204060" }
  ]
}
```

说明：

- 页面上在**背景图**点击取点，缩放显示时按「点击位置 ÷ 显示尺寸 × 原图像素」换算回原图像素；目标图只同步显示相同坐标的标号，不可点击。
- 颜色对先展示、由用户确认后才由客户端**整批**追加到现有 `samples`（即每组 `{"background": backgroundHex, "target": targetHex}`，顺序与提交一致）并重新调用 `/api/solve`；**同批仅能追加一次**，且「现有样本组数 + 本批点数」超过 4 组时页面**整批拒绝、不发追加**（接口本身与样本无关，可随时重复提取）。
- 校验失败返回 HTTP 400 JSON（与其他接口同一错误结构），`scope` 为 `image` / `points` / `form`：

```json
{ "errors": [
  { "scope": "image",  "message": "缺少背景图文件：请通过 multipart 表单字段 background 上传一张 PNG 图片" },
  { "scope": "image",  "message": "背景图体积 2097200 字节超出 2 MiB（2097152 字节）上限，请压缩或裁剪后重试" },
  { "scope": "image",  "message": "背景图已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片" },
  { "scope": "image",  "message": "背景图格式必须是 PNG，实际为 JPEG（不接受 JPEG / GIF / WebP 等）" },
  { "scope": "image",  "message": "目标图必须是 RGB 模式 PNG，实际为 RGBA 模式（请先转换为 RGB，不接受索引色 / RGBA / 灰度 / 黑白）" },
  { "scope": "image",  "message": "两张图片尺寸不符：背景图为 256×256，目标图为 255×255，必须选择两张同尺寸 PNG" },
  { "scope": "image",  "message": "背景图尺寸 768×512 超出上限：宽、高均不得超过 512 像素（服务端不会缩放，请自行裁剪）" },
  { "scope": "points", "message": "取点数量必须在 1～4 个之间，当前 0 个" },
  { "scope": "points", "message": "坐标重复：(10, 20)，每个位置只能选择一次", "index": 1 },
  { "scope": "points", "message": "坐标 (260, 10) 越界：图片尺寸为 256×256，x、y 取值范围分别为 0～255、0～255", "index": 1 },
  { "scope": "points", "message": "坐标必须是左上角为原点的零基整数（x、y 均为整数），实际为 1.5, 0", "index": 0 },
  { "scope": "form",   "message": "缺少 payload 表单字段：应为包含 points 坐标列表的 JSON 文本" },
  { "scope": "form",   "message": "payload 字段不是合法的 JSON" }
] }
```

## 不用 Docker 的本地运行方式（可选）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

计算核心（`app/core.py`）零第三方依赖，可直接 `python3 -c "from app import core; ..."` 单测；图片合成预览（`app/composite.py`）的解码 / 编码使用 Pillow。

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── core.py        # sRGB 转换 / alpha 合成 / 环检测 / 枚举择优 / 图层影响诊断 / 不透明度反推 / 背景测量建议 / 实测颜色复核 / 过渡步骤规划 / 成环解除方案（纯标准库）
│   ├── composite.py   # 背景图片合成预览：PNG/RGB/2MiB/512 校验 + 固定顺序逐像素线性光合成（Pillow）
│   ├── picker.py      # 图片像素取点：两图 PNG/RGB/同尺寸/2MiB/512 校验 + 对应像素原始 RGB/HEX 提取（Pillow）
│   └── main.py        # FastAPI：/api/solve、/api/infer-opacity、/api/suggest-background、/api/review-measurement、/api/plan-transition、/api/resolve-cycle、/api/confirm-cycle-resolution、/api/composite-preview、/api/pick-samples 与静态页面托管
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt   # fastapi / uvicorn / pillow / python-multipart
├── Dockerfile
├── docker-compose.yml
└── README.md
```
