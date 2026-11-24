/**
 * 高频效率页（广场 / 闯关 / 战队 / 我的）不再叠放顶部装饰眉标条，
 * 避免与顶栏标题重复并释放首屏空间。
 */
export function paintScene(root) {
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
}
