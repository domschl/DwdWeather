# Maintainer: Antigravity Coding Agent <antigravity@google.com>
pkgname=python-dwdweather
pkgver=0.1.0
pkgrel=1
pkgdesc="Modern DWD Weather Server and Dashboard"
arch=('any')
url="https://codeberg.org/dsc/DwdWeather"
license=('MIT')
depends=('python' 'python-fastapi' 'python-uvicorn' 'python-pydantic')
makedepends=('python-build' 'python-installer' 'python-hatchling')
backup=('etc/dwdweather/config.json')
source=('dwd-server.service'
        'dwd_server'
        'pyproject.toml'
        'OldVersion/LICENSE')
sha256sums=('SKIP'
            'SKIP'
            'SKIP'
            'SKIP')

build() {
  cd "$srcdir"
  mkdir -p build_src
  cp -r dwd_server pyproject.toml build_src/
  cd build_src
  python -m build --wheel --no-isolation
}

package() {
  cd "$srcdir/build_src"
  python -m installer --destdir="$pkgdir" dist/*.whl

  # Install systemd service
  install -Dm644 "$srcdir/dwd-server.service" "$pkgdir/usr/lib/systemd/system/dwd-server.service"

  # Create config directory and default configuration file
  install -d "$pkgdir/etc/dwdweather"
  install -Dm644 /dev/stdin "$pkgdir/etc/dwdweather/config.json" <<EOF
{
  "station_id": "10865",
  "cache_expiry_secs": 3600,
  "port": 8089,
  "host": "0.0.0.0"
}
EOF

  # Install license file
  install -Dm644 "$srcdir/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
# vim:set ts=2 sw=2 et:
