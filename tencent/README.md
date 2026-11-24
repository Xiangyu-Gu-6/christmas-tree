# 共享圣诞树的腾讯云部署包

适用于腾讯云 Linux 实例。网页、上传接口、图片读取、字体、3D 模块及手势模型都从同一网站提供。公开照片存入服务器磁盘上的 SQLite 数据库。原 Sites 私密存档继续由原站管理。

## 在实例上运行

- 安装 Node.js 24 和 Caddy。将解包目录放在应用用户可读的位置，并为数据库准备该用户可写的持久目录。解包后的 `assets/` 已包含浏览器依赖。
- 在服务的环境配置中设置 `SITE_ORIGIN=https://你的域名`、`UPLOAD_SIGNING_KEY`（随机生成至少 32 字符）、`PHOTO_DATABASE`（SQLite 文件绝对路径）和 `TRUST_LOCAL_PROXY=1`。从解包目录用 `node server.mjs` 启动。应用默认只监听 `127.0.0.1:8080`，使用 systemd 管理常驻进程。
- 将域名指向实例，放通 80 和 443 端口。在 Caddy 的环境配置中设置 `SITE_HOSTNAME` 并使用包内的 `Caddyfile`，让 Caddy 处理 HTTPS。使用浏览器验证树、公开照片和上传，再请大陆访客用实际网络验证。
- 迁移原站已公开的照片时，运行 `node import-photos.mjs https://shared-xmas-tree.guxiangyu1201.chatgpt.site /持久目录/photos.sqlite`。脚本保留原公开照片的 ID 与顺序，重复运行跳过已导入的照片。迁移是一次复制，两个入口之后分别保存各自收到的上传。

## 从源码打包

运行 `python3 tencent/package.py /绝对路径/共享圣诞树-腾讯云.tar.gz`。打包器下载并校验固定版本依赖。也可通过 `--assets-dir` 使用已经下载的文件。
