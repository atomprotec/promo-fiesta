const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = 'secreto_super_seguro_promo_fiesta';

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Error DB:', err.message);
  else console.log('✅ Base de datos SQLite lista.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    precio REAL,
    stock INTEGER,
    imagen TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL,
    usuario_id INTEGER,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS fichajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    entrada DATETIME DEFAULT CURRENT_TIMESTAMP,
    salida DATETIME
  )`);

  // Crear productos iniciales si está vacío
  db.get("SELECT COUNT(*) as count FROM productos", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO productos (nombre, precio, stock, imagen) VALUES ('Pack Paty', 5000, 50, '🍔')");
      db.run("INSERT INTO productos (nombre, precio, stock, imagen) VALUES ('Bolsa Pan', 2500, 40, '🥖')");
    }
  });

  // Cuenta Jefe por defecto
  db.get("SELECT COUNT(*) as count FROM users WHERE role = 'OWNER'", async (err, row) => {
    if (row && row.count === 0) {
      const hashed = await bcrypt.hash('123456', 10);
      db.run(`INSERT INTO users (nombre, email, password, role) VALUES ('Jefe', 'admin@promofiesta.com', ?, 'OWNER')`, [hashed]);
      console.log('✅ Cuenta de Jefe creada: admin@promofiesta.com / 123456');
    }
  });
});

const verificarToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ mensaje: 'No autorizado' });
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    res.status(401).json({ mensaje: 'Token inválido' });
  }
};

// --- RUTAS API --- //

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (!user) return res.status(404).json({ mensaje: 'Usuario no encontrado' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ mensaje: 'Contraseña incorrecta' });
    const token = jwt.sign({ id: user.id, nombre: user.nombre, role: user.role }, SECRET, { expiresIn: '12h' });
    res.json({ token, role: user.role, nombre: user.nombre, id: user.id });
  });
});

app.get('/api/productos', verificarToken, (req, res) => {
  db.all("SELECT * FROM productos", [], (err, rows) => res.json(rows || []));
});

app.post('/api/ventas', verificarToken, (req, res) => {
  const { items } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ mensaje: 'Sin items' });

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    let totalVenta = 0;
    let procesados = 0;

    items.forEach(item => {
      db.get("SELECT precio, stock, nombre FROM productos WHERE id = ?", [item.id], (err, prod) => {
        if (!prod || prod.stock < item.cantidad) {
          db.run("ROLLBACK");
          return res.status(400).json({ mensaje: `Stock insuficiente para ${prod ? prod.nombre : 'producto'}` });
        }

        totalVenta += prod.precio * item.cantidad;
        procesados++;

        if (procesados === items.length) {
          db.run("INSERT INTO ventas (total, usuario_id) VALUES (?, ?)", [totalVenta, req.usuario.id], function() {
            items.forEach(i => {
              db.run("UPDATE productos SET stock = stock - ? WHERE id = ?", [i.cantidad, i.id]);
            });
            db.run("COMMIT");
            res.json({ mensaje: '¡Venta registrada!' });
          });
        }
      });
    });
  });
});

app.get('/api/mis-ventas', verificarToken, (req, res) => {
  db.get("SELECT COUNT(*) as misVentas FROM ventas WHERE usuario_id = ?", [req.usuario.id], (err, row) => {
    res.json({ misVentas: row ? row.misVentas : 0 });
  });
});

app.get('/api/owner/resumen', verificarToken, (req, res) => {
  if (req.usuario.role !== 'OWNER') return res.status(403).json({ mensaje: 'Acceso denegado' });

  db.get("SELECT SUM(total) as totalDinero, COUNT(*) as cantidadVentas FROM ventas", [], (err, totalRow) => {
    db.all("SELECT * FROM productos", [], (err, productos) => {
      db.all(`
        SELECT ventas.id, ventas.total, ventas.fecha, users.nombre as empleado 
        FROM ventas 
        JOIN users ON ventas.usuario_id = users.id 
        ORDER BY ventas.id DESC
      `, [], (err, ventas) => {
        db.all(`
          SELECT users.nombre as empleado, SUM(ventas.total) as totalVendido, COUNT(ventas.id) as cantidadVentas
          FROM users
          LEFT JOIN ventas ON users.id = ventas.usuario_id
          WHERE users.role = 'TRABAJADOR'
          GROUP BY users.id
        `, [], (err, ventasPorTrabajador) => {
          db.all(`
            SELECT fichajes.id, fichajes.entrada, fichajes.salida, users.nombre as empleado
            FROM fichajes
            JOIN users ON fichajes.usuario_id = users.id
            ORDER BY fichajes.id DESC LIMIT 10
          `, [], (err, fichajes) => {
            res.json({
              totalDineroGeneral: totalRow?.totalDinero || 0,
              cantidadVentas: totalRow?.cantidadVentas || 0,
              productos: productos || [],
              ventas: ventas || [],
              ventasPorTrabajador: ventasPorTrabajador || [],
              fichajes: fichajes || []
            });
          });
        });
      });
    });
  });
});

app.post('/api/owner/reiniciar-caja', verificarToken, (req, res) => {
  if (req.usuario.role !== 'OWNER') return res.status(403).json({ mensaje: 'Acceso denegado' });
  db.run("DELETE FROM ventas", [], (err) => {
    if (err) return res.status(500).json({ mensaje: '
