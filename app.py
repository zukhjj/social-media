# ══════════════════════════════════════════════════════════════
# server.py — Social Grid Backend (Flask + PostgreSQL + Cloudinary)
# ══════════════════════════════════════════════════════════════

import os, sys, logging, time, random, datetime, jwt, threading, hashlib, hmac, json
from urllib.parse import urlparse
from functools import wraps
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, request, jsonify, send_from_directory, g
from flask_cors import CORS
from flask_caching import Cache
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from psycopg2 import pool, OperationalError
import cloudinary.uploader, cloudinary.api
import smtplib
import random
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
SMTP_EMAIL = os.environ.get("SMTP_EMAIL", "ahmedaminenouily@gmail.com") 
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "bvnn obqn igmy lasa")

# ─────────────────────────────────────────────────────────────
# Logging Setup
# ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────
# Flask App Setup
# ─────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="")

app.secret_key = os.environ.get("SECRET_KEY", "c10fc560f0a1f805a854f9992a6d955de3d53dee0a395e0273aefea8e8b32518")
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max upload

# Extensions
CORS(app)
cache = Cache(app, config={'CACHE_TYPE': 'SimpleCache', 'CACHE_DEFAULT_TIMEOUT': 60})
Compress(app)
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["120 per minute", "20 per second"],
    storage_uri="memory://"
)

# Cloudinary Config
cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME", "dlimysibj"),
    api_key=os.environ.get("CLOUDINARY_API_KEY", "239576522747935"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET", "sn4KlQ9Q-KwEqjOUxvF-MmO2ln8")
)

# Thread pool for background tasks
executor = ThreadPoolExecutor(max_workers=2)

# ─────────────────────────────────────────────────────────────
# Database Pool Setup
# ─────────────────────────────────────────────────────────────
_db_pool = None
_last_seen_lock = threading.Lock()
_last_seen_cache = {}

def init_db_pool():
    global _db_pool
    
    try:
        db_url = os.environ.get(
            "DATABASE_URL",
            "postgresql://neondb_owner:npg_UATC3pfibMd6@ep-cold-cake-abnyap5j-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
        )
        result = urlparse(db_url)
        _db_pool = pool.ThreadedConnectionPool(
            minconn=1, maxconn=6,
            host=result.hostname, port=result.port or 5432,
            database=result.path.lstrip('/'),
            user=result.username, password=result.password,
            sslmode='require', connect_timeout=10,
            keepalives=1, keepalives_idle=30,
            keepalives_interval=10, keepalives_count=3
        )
        logger.info("✅ DB pool ready (max 6 connections)")
        return True
    except Exception as e:
        logger.error(f"❌ Pool init failed: {e}")
        return False

def get_conn(retries=3):
    if not _db_pool: return None
    for i in range(retries + 1):
        try:
            conn = _db_pool.getconn()
            if conn.closed:
                try: _db_pool.putconn(conn)
                except: pass
                continue
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            return conn
        except OperationalError:
            if i < retries:
                time.sleep(0.3 * (i + 1))
                continue
            logger.error("❌ DB connect failed after retries")
            return None
        except Exception as e:
            logger.error(f"❌ DB error: {e}")
            return None
    return None

def release_conn(conn):
    if conn and _db_pool:
        try:
            _db_pool.putconn(conn)
        except:
            try: conn.close()
            except: pass

# ─────────────────────────────────────────────────────────────
# Password Hashing Helpers
# ─────────────────────────────────────────────────────────────
def _hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000)
    return f"{salt}${h.hex()}"

def _verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    if "$" in stored and len(stored) > 60:
        parts = stored.split("$", 1)
        if len(parts) != 2:
            return False
        salt, digest = parts
        h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000)
        return hmac.compare_digest(h.hex(), digest)
    return stored == password

def _maybe_migrate_password(cur, conn, uid: int, plaintext: str):
    """Migrate old plaintext passwords to hashed format"""
    try:
        cur.execute("SELECT password FROM users WHERE id=%s", (uid,))
        row = cur.fetchone()
        if row and "$" not in str(row[0]):
            new_hash = _hash_password(plaintext)
            cur.execute("UPDATE users SET password=%s WHERE id=%s", (new_hash, uid))
            conn.commit()
    except Exception:
        pass

# ─────────────────────────────────────────────────────────────
# Token Authentication Decorator
# ─────────────────────────────────────────────────────────────
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization", "")
        if not token:
            return jsonify({"msg": "no_token"}), 401
        try:
            token = token.replace("Bearer ", "").strip()
            data = jwt.decode(token, app.secret_key, algorithms=["HS256"])
            g.user_data = data
            g.user_id = data.get("user_id") or data.get("user")
            if not g.user_id:
                return jsonify({"msg": "invalid_token"}), 401
        except jwt.ExpiredSignatureError:
            return jsonify({"msg": "token_expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"msg": "invalid_token"}), 401
        except Exception as e:
            logger.error(f"Token error: {e}")
            return jsonify({"msg": "server_error"}), 500
        return f(*args, **kwargs)
    return decorated

# ─────────────────────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────────────────────
def resolve_user_id(cur, user_val):
    """Convert username or ID to numeric user ID"""
    if isinstance(user_val, int):
        return user_val
    try:
        return int(user_val)
    except (ValueError, TypeError):
        pass
    cur.execute("SELECT id FROM users WHERE username = %s", (str(user_val),))
    row = cur.fetchone()
    return row[0] if row else None

def update_last_seen(user_id):
    """Update user's last_seen timestamp (debounced)"""
    now = time.time()
    with _last_seen_lock:
        last = _last_seen_cache.get(user_id, 0)
        if now - last < 20:
            return
        _last_seen_cache[user_id] = now
    
    def _update():
        conn = get_conn()
        if not conn: return
        try:
            cur = conn.cursor()
            cur.execute("UPDATE users SET last_seen = NOW() WHERE id = %s", (user_id,))
            conn.commit()
            cur.close()
        except:
            pass
        finally:
            release_conn(conn)
    executor.submit(_update)

def user_cache_key(prefix, user_id, *extra):
    """Generate cache key for user-specific data"""
    parts = [prefix, str(user_id)] + [str(e) for e in extra]
    return ":".join(parts)

def extract_public_id(url):
    """Extract Cloudinary public_id from URL for deletion"""
    if not url or "cloudinary" not in url: return None
    try:
        parts = url.split("/upload/")
        if len(parts) < 2: return None
        path = parts[1]
        if path.startswith("v") and "/" in path:
            path = path.split("/", 1)[1]
        return path.rsplit(".", 1)[0]
    except:
        return None

def delete_asset_bg(url, rtype="image"):
    """Background task to delete media from Cloudinary"""
    pid = extract_public_id(url)
    if not pid: return
    try:
        cloudinary.api.delete_resources([pid], resource_type=rtype)
    except:
        pass

def invalidate_feed_cache():
    """Invalidate post feed cache for all users"""
    for page in range(1, 4):
        for per_page in [20, 50]:
            cache.delete(f"posts:feed:{page}:{per_page}:None")
    try:
        if g and g.user_id:
            conn = get_conn()
            if conn:
                cur = conn.cursor()
                try:
                    uid = resolve_user_id(cur, g.user_id)
                    if uid:
                        for page in range(1, 4):
                            for per_page in [20, 50]:
                                cache.delete(f"posts:feed:{page}:{per_page}:{uid}")
                finally:
                    cur.close()
                    release_conn(conn)
        cache.clear() 
    except Exception:
        pass

def parse_images(image_field):
    """Parse image field (single URL or JSON array) into list"""
    if not image_field:
        return []
    s = image_field.strip()
    if s.startswith("["):
        try:
            return json.loads(s)
        except Exception:
            pass
    return [s]

# ─────────────────────────────────────────────────────────────
# Static File Routes
# ─────────────────────────────────────────────────────────────
@app.route("/")
def root(): return send_from_directory("static", "root.html")

@app.route("/home.html")
def serve_home(): return send_from_directory("static", "home.html")

@app.route("/login.html")
def serve_login(): return send_from_directory("static", "login.html")

@app.route("/sign_up.html")
def serve_signup(): return send_from_directory("static", "sign_up.html")

@app.route("/messages.html")
def serve_messages(): return send_from_directory("static", "messages.html")

@app.route("/health")
@limiter.exempt
def health():
    conn = get_conn()
    if not conn:
        return jsonify({"status": "unhealthy", "error": "db_connection_failed"}), 503
    cur = conn.cursor()
    cur.execute("SELECT 1")
    cur.close()
    release_conn(conn)
    return jsonify({"status": "healthy", "ts": datetime.datetime.utcnow().isoformat()})
# ─────────────────────────────────────────────────────────────
# 📧 EMAIL OTP LOGIN ROUTES
# ─────────────────────────────────────────────────────────────

def send_otp_email(to_email, otp_code):
    """دالة لإرسال الإيميل بتنسيق HTML جميل"""
    try:
        msg = MIMEMultipart()
        msg['From'] = SMTP_EMAIL
        msg['To'] = to_email
        msg['Subject'] = "Social Grid - Login Verification Code"
        
        body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 400px; margin: auto; padding: 20px; border: 1px solid #27272a; border-radius: 10px; text-align: center; background: #111114; color: white;">
            <h2 style="color: #1bc35e;">Social Grid</h2>
            <p>Your login verification code is:</p>
            <h1 style="letter-spacing: 8px; color: #1bc35e; font-size: 32px;">{otp_code}</h1>
            <p style="color: #71717a; font-size: 12px;">This code will expire in 10 minutes. Do not share it with anyone.</p>
        </div>
        """
        msg.attach(MIMEText(body, 'html'))
        
        server = smtplib.SMTP('smtp.gmail.com', 587)
        server.starttls()
        server.login(SMTP_EMAIL, SMTP_PASSWORD)
        server.send_message(msg)
        server.quit()
        return True
    except Exception as e:
        logger.error(f"Email send error: {e}")
        return False

@app.route("/request_login_otp", methods=["POST"])
@limiter.limit("3 per minute") 
def request_login_otp():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    if not email: return jsonify({"msg": "email_required"}), 400
        
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id FROM users WHERE email=%s", (email,))
        if not cur.fetchone():
            return jsonify({"msg": "user_not_found"}), 404
            
        otp_code = str(random.randint(100000, 999999))
        expires = datetime.datetime.utcnow() + datetime.timedelta(minutes=10)
        
        cur.execute(
            "UPDATE users SET otp_code=%s, otp_expires=%s WHERE email=%s",
            (otp_code, expires, email)
        )
        conn.commit()
        
        if send_otp_email(email, otp_code):
            return jsonify({"msg": "otp_sent"})
        else:
            return jsonify({"msg": "email_failed"}), 500
            
    except Exception as e:
        conn.rollback(); logger.error(f"Request OTP error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/verify_login_otp", methods=["POST"])
def verify_login_otp():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    otp_code = (data.get("otp_code") or "").strip()
    
    if not email or not otp_code: 
        return jsonify({"msg": "missing_fields", "error": "Please enter the code"}), 400
        
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error", "error": "Server error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id, username, profile_picture, otp_code, otp_expires FROM users WHERE email=%s", (email,))
        user = cur.fetchone()
        if not user: 
            return jsonify({"msg": "user_not_found", "error": "User not found"}), 404
            
        uid, uname, pic, stored_otp, expires = user

        if not stored_otp:
            return jsonify({"msg": "no_otp_requested", "error": "No code was requested. Please try logging in again."}), 401
            
        if stored_otp != otp_code:
            return jsonify({"msg": "invalid_otp", "error": "Wrong code. Please check and try again."}), 401
            
        if expires < datetime.datetime.utcnow():
            cur.execute("UPDATE users SET otp_code=NULL, otp_expires=NULL WHERE id=%s", (uid,))
            conn.commit()
            return jsonify({"msg": "otp_expired", "error": "Code expired. Please request a new one."}), 401

        cur.execute("UPDATE users SET otp_code=NULL, otp_expires=NULL WHERE id=%s", (uid,))
        conn.commit()
        
        token = jwt.encode(
            {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        
        return jsonify({
            "msg": "verified", 
            "token": token, 
            "username": uname, 
            "profile_picture": pic or "unknown"
        })
        
    except Exception as e:
        conn.rollback(); logger.error(f"Verify OTP error: {e}")
        return jsonify({"msg": "error", "error": "Server error. Please try again."}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/api/verify", methods=["GET"])
@token_required
def verify_token():
    conn = get_conn()
    username = None
    if conn:
        cur = conn.cursor()
        try:
            uid = resolve_user_id(cur, g.user_id)
            if uid:
                cur.execute("SELECT username FROM users WHERE id=%s", (uid,))
                row = cur.fetchone()
                if row: username = row[0]
        finally:
            cur.close(); release_conn(conn)
    if not username:
        username = g.user_data.get("user") or str(g.user_id)
    return jsonify({"msg": "ok", "username": username})

# ─────────────────────────────────────────────────────────────
# Authentication Routes
# ─────────────────────────────────────────────────────────────
@app.route("/signup", methods=["POST"])
@limiter.limit("5 per minute")
def signup():
    data = request.json or {}
    name = data.get("name", "").strip()
    email = (data.get("email") or "").strip().lower() or None
    phone = (data.get("phone") or "").strip() or None
    password = data.get("password", "")
    
    if not email and not phone:
        return jsonify({"msg": "need_email_or_phone"}), 400
    if not password or len(password) < 6:
        return jsonify({"msg": "password_too_short"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
    
        if email:
            cur.execute("SELECT 1 FROM users WHERE email=%s", (email,))
            if cur.fetchone(): 
                return jsonify({"msg": "email_used", "error": "Email already registered"}), 409
            

            cur.execute("SELECT 1 FROM pending_signups WHERE email=%s", (email,))
            if cur.fetchone():
                return jsonify({"msg": "pending_exists", "error": "Verification already sent. Check your email."}), 409
                
        if phone:
            cur.execute("SELECT 1 FROM users WHERE phone=%s", (phone,))
            if cur.fetchone(): 
                return jsonify({"msg": "phone_used", "error": "Phone already registered"}), 409
        
        otp_code = str(random.randint(100000, 999999))
        expires = datetime.datetime.utcnow() + datetime.timedelta(minutes=10)
        
        hashed = _hash_password(password)
        cur.execute("""
            INSERT INTO pending_signups (email, phone, name, password, otp_code, otp_expires)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (email, phone, name, hashed, otp_code, expires))
        conn.commit()
        

        if email and send_otp_email(email, otp_code):
            return jsonify({
                "msg": "otp_sent",
                "email": email
            })
        else:
          
            cur.execute("DELETE FROM pending_signups WHERE email=%s", (email,))
            conn.commit()
            return jsonify({"msg": "email_failed", "error": "Failed to send verification code"}), 500
        
    except Exception as e:
        conn.rollback()
        logger.error(f"Signup: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/verify_signup_otp", methods=["POST"])
def verify_signup_otp():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    otp_code = (data.get("otp_code") or "").strip()
    
    if not email or not otp_code: 
        return jsonify({"msg": "missing_fields", "error": "Please enter the code"}), 400
        
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error", "error": "Server error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("""
            SELECT id, name, email, phone, password, otp_code, otp_expires
            FROM pending_signups WHERE email=%s
        """, (email,))
        pending = cur.fetchone()
        
        if not pending:
            return jsonify({"msg": "no_pending", "error": "No signup request found. Please sign up again."}), 404
        
        pending_id, name, email, phone, hashed_password, stored_otp, expires = pending
        

        if stored_otp != otp_code:
            return jsonify({"msg": "invalid_otp", "error": "Wrong code. Please check and try again."}), 401
            
        if expires < datetime.datetime.utcnow():
            cur.execute("DELETE FROM pending_signups WHERE id=%s", (pending_id,))
            conn.commit()
            return jsonify({"msg": "otp_expired", "error": "Code expired. Please sign up again."}), 401
        

        username = None
        for _ in range(10):
            candidate = name.lower().replace(" ", "")[:12] + str(random.randint(1000, 9999))
            cur.execute("SELECT 1 FROM users WHERE username=%s", (candidate,))
            if not cur.fetchone():
                username = candidate
                break
        
        if not username:
            return jsonify({"msg": "username_failed", "error": "Failed to generate username"}), 500
        

        cur.execute("""
            INSERT INTO users (name, email, phone, username, password, account_status)
            VALUES (%s, %s, %s, %s, %s, 'pending_verification')
        """, (name, email, phone, username, hashed_password))
        
     
        cur.execute("DELETE FROM pending_signups WHERE id=%s", (pending_id,))
        conn.commit()
        

        cur.execute("SELECT id FROM users WHERE username=%s", (username,))
        uid = cur.fetchone()[0]
        
     
        token = jwt.encode(
            {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1)},
            app.secret_key, algorithm="HS256"
        )
        
        return jsonify({
            "msg": "verified", 
            "token": token, 
            "username": username,
            "needs_welcome": True
        })
        
    except Exception as e:
        conn.rollback(); logger.error(f"Verify signup OTP error: {e}")
        return jsonify({"msg": "error", "error": "Server error"}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/resend_signup_otp", methods=["POST"])
@limiter.limit("3 per minute")
def resend_signup_otp():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    
    if not email:
        return jsonify({"msg": "email_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id, name, phone, password FROM pending_signups WHERE email=%s", (email,))
        pending = cur.fetchone()
        
        if not pending:
            return jsonify({"msg": "no_pending", "error": "No signup request found"}), 404
        
        pending_id, name, phone, hashed_password = pending
        

        otp_code = str(random.randint(100000, 999999))
        expires = datetime.datetime.utcnow() + datetime.timedelta(minutes=10)
        

        cur.execute("""
            UPDATE pending_signups 
            SET otp_code=%s, otp_expires=%s 
            WHERE id=%s
        """, (otp_code, expires, pending_id))
        conn.commit()
        

        if send_otp_email(email, otp_code):
            return jsonify({"msg": "otp_resent"})
        else:
            return jsonify({"msg": "email_failed"}), 500
        
    except Exception as e:
        conn.rollback(); logger.error(f"Resend OTP error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)
# ─────────────────────────────────────────────────────────────
# 🎉 COMPLETE GOOGLE WELCOME (After Google Auth)
# ─────────────────────────────────────────────────────────────
@app.route("/complete_google_welcome", methods=["POST"])
@token_required
def complete_google_welcome():
    name = request.form.get("name", "").strip()
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    profile_image = request.files.get("profile_image")
    
    if not name or not username or not password:
        return jsonify({"msg": "missing_fields", "error": "All fields are required"}), 400
    
    if len(password) < 6:
        return jsonify({"msg": "password_too_short", "error": "Password must be at least 6 characters"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        uid = resolve_user_id(cur, g.user_id)
        if not uid: return jsonify({"msg": "user_not_found"}), 404
        
       
        cur.execute("SELECT 1 FROM users WHERE username=%s AND id!=%s", (username, uid))
        if cur.fetchone():
            return jsonify({"msg": "username_taken", "error": "Username already taken"}), 409
        
   
        hashed_password = _hash_password(password)
        
        updates = ["name=%s", "username=%s", "password=%s", "account_status='fully_setup'"]
        params = [name, username, hashed_password]
        

        if profile_image and profile_image.filename:
            res = cloudinary.uploader.upload(profile_image, folder='socialgrid/profiles')
            updates.append("profile_picture=%s")
            params.append(res["secure_url"])
        
        params.append(uid)
        cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=%s", params)
        conn.commit()
        

        token = jwt.encode(
            {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        
        cur.execute("SELECT username, profile_picture FROM users WHERE id=%s", (uid,))
        user_data = cur.fetchone()
        
        return jsonify({
            "msg": "welcome_complete",
            "token": token,
            "username": user_data[0],
            "profile_picture": user_data[1] or "unknown"
        })
        
    except Exception as e:
        conn.rollback(); logger.error(f"Complete Google welcome error: {e}")
        return jsonify({"msg": "error", "error": "Server error"}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/complete_welcome", methods=["POST"])
@token_required
def complete_welcome():
    profile_image = request.files.get("profile_image")
    new_username = request.form.get("username", "").strip()
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        uid = resolve_user_id(cur, g.user_id)
        if not uid: return jsonify({"msg": "user_not_found"}), 404
        
        updates = []
        params = []
        
        if profile_image and profile_image.filename:
            res = cloudinary.uploader.upload(profile_image, folder='socialgrid/profiles')
            updates.append("profile_picture=%s")
            params.append(res["secure_url"])
        
        if new_username:
            cur.execute("SELECT 1 FROM users WHERE username=%s AND id!=%s", (new_username, uid))
            if cur.fetchone():
                return jsonify({"msg": "username_taken"}), 409
            updates.append("username=%s")
            params.append(new_username)
       
        updates.append("account_status='fully_setup'")
        
        if updates:
            params.append(uid)
            cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=%s", params)
            conn.commit()
        
       
        token = jwt.encode(
            {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        
        cur.execute("SELECT username, profile_picture FROM users WHERE id=%s", (uid,))
        user_data = cur.fetchone()
        
        return jsonify({
            "msg": "welcome_complete",
            "token": token,
            "username": user_data[0],
            "profile_picture": user_data[1] or "unknown"
        })
        
    except Exception as e:
        conn.rollback(); logger.error(f"Complete welcome error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)
@app.route("/login", methods=["POST"])
@limiter.limit("10 per minute")
def login():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower() or None
    phone = (data.get("phone") or "").strip() or None
    password = data.get("password", "")
    
    if not email and not phone:
        return jsonify({"msg": "email_or_phone_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        if email:
            cur.execute("SELECT id,username,password,profile_picture FROM users WHERE email=%s", (email,))
        else:
            cur.execute("SELECT id,username,password,profile_picture FROM users WHERE phone=%s", (phone,))
        
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 401
        
        uid, uname, stored_pw, pic = user
       
        if not _verify_password(password, stored_pw):
            return jsonify({"msg": "wrong_password"}), 401
        
        if stored_pw and "$" not in stored_pw:
            _maybe_migrate_password(cur, conn, uid, password)
        
        
        otp_code = str(random.randint(100000, 999999))
        expires = datetime.datetime.utcnow() + datetime.timedelta(minutes=10)
        
        cur.execute(
            "UPDATE users SET otp_code=%s, otp_expires=%s WHERE id=%s",
            (otp_code, expires, uid)
        )
        conn.commit()
        
       
        if email and send_otp_email(email, otp_code):
            return jsonify({"msg": "otp_sent"}) 
        else:
            
            token = jwt.encode(
                {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
                app.secret_key, algorithm="HS256"
            )
            return jsonify({"msg": "success", "token": token, "profile_picture": pic or "unknown"})
        
    finally:
        cur.close(); release_conn(conn)
@app.route("/google-login", methods=["POST"])
@limiter.limit("10 per minute")
def google_login():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    picture = data.get("picture") or "unknown"
    
    if not email or not name:
        return jsonify({"msg": "email_and_name_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id,username,profile_picture,account_status FROM users WHERE email=%s", (email,))
        user = cur.fetchone()
        
        if user:
            uid, username, old_pic, status = user
            

            if status == 'fully_setup':
                if picture != "unknown" and picture != old_pic:
                    cur.execute("UPDATE users SET profile_picture=%s WHERE id=%s", (picture, uid))
                    conn.commit()
                
                token = jwt.encode(
                    {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
                    app.secret_key, algorithm="HS256"
                )
                return jsonify({
                    "msg": "success", 
                    "token": token, 
                    "username": username, 
                    "profile_picture": picture or "unknown",
                    "needs_welcome": False
                })
            else:
              
                token = jwt.encode(
                    {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1)},
                    app.secret_key, algorithm="HS256"
                )
                return jsonify({
                    "msg": "needs_setup",
                    "token": token,
                    "username": username,
                    "name": name,
                    "profile_picture": picture,
                    "needs_welcome": True
                })
        else:

            username = None
            for _ in range(10):
                candidate = name.lower().replace(" ", "")[:12] + str(random.randint(1000, 9999))
                cur.execute("SELECT 1 FROM users WHERE username=%s", (candidate,))
                if not cur.fetchone():
                    username = candidate
                    break
            if not username:
                return jsonify({"msg": "username_failed"}), 500
            
            cur.execute(
                """INSERT INTO users (name,email,username,password,profile_picture,account_status) 
                   VALUES (%s,%s,%s,'google_auth',%s,'pending_google_setup')""",
                (name, email, username, picture)
            )
            conn.commit()
            cur.execute("SELECT id FROM users WHERE username=%s", (username,))
            uid = cur.fetchone()[0]

            token = jwt.encode(
                {"user_id": uid, "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1)},
                app.secret_key, algorithm="HS256"
            )
            return jsonify({
                "msg": "needs_setup",
                "token": token,
                "username": username,
                "name": name,
                "profile_picture": picture,
                "needs_welcome": True
            })
        
    except Exception as e:
        conn.rollback(); logger.error(f"Google login: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)
# ─────────────────────────────────────────────────────────────
# Posts Routes
# ─────────────────────────────────────────────────────────────
@app.route("/add_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_post():
    content = request.form.get("content", "").strip()
    image_url = request.form.get("image_url")
    images_json = request.form.get("images_json")
    video_url = request.form.get("video_url")
    visibility = request.form.get("visibility", "public")
    
    if visibility not in ('public', 'private', 'friends'):
        visibility = 'public'

    # Resolve stored image value
    stored_image = None
    if images_json:
        try:
            arr = json.loads(images_json)
            if isinstance(arr, list) and arr:
                stored_image = json.dumps(arr)
        except Exception:
            pass
    elif image_url:
        stored_image = image_url

    if not content and not stored_image and not video_url:
        return jsonify({"msg": "empty_post"}), 400

    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        # ✅ 1. Insert the post AND get the new post's ID immediately
        cur.execute(
            "INSERT INTO posts (user_id, content, image, video, visibility) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (user_id, content or None, stored_image, video_url, visibility)
        )
        new_post_id = cur.fetchone()[0]
        
        # ✅ 2. Notify ALL followers about this new post in one fast query!
        cur.execute("""
            INSERT INTO notifications (receiver_id, actor_id, type, post_id)
            SELECT follower_id, %s, 'new_post', %s
            FROM follows WHERE following_id = %s AND follower_id != %s
        """, (user_id, new_post_id, user_id, user_id))

        conn.commit()
        invalidate_feed_cache()
        return jsonify({"msg": "post_created"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Add post: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

def _serialize_post(r):
    """Convert DB row to post dict with images array"""
    images = parse_images(r[2])
    return {
        "id": r[0], "content": r[1],
        "image": images[0] if len(images) == 1 else (images[0] if images else None),
        "images": images,
        "video": r[3],
        "likes": r[4], "comments": r[5], "reposts": r[6],
        "visibility": r[7], "username": r[8], "profile_picture": r[9],
        "is_saved": r[10] if len(r) > 10 else False 
    }

@app.route("/get_posts", methods=["GET"])
@limiter.limit("60 per minute")
def get_posts():
    page = max(1, request.args.get('page', 1, type=int))
    per_page = min(50, request.args.get('per_page', 20, type=int))
    token = request.headers.get("Authorization", "")

    current_user_id = None
    if token:
        try:
            token_clean = token.replace("Bearer ", "").strip()
            data = jwt.decode(token_clean, app.secret_key, algorithms=["HS256"])
            user_val = data.get("user_id") or data.get("user")
            if user_val:
                conn_temp = get_conn()
                if conn_temp:
                    cur_temp = conn_temp.cursor()
                    try:
                        current_user_id = resolve_user_id(cur_temp, user_val)
                    finally:
                        cur_temp.close()
                        release_conn(conn_temp)
        except Exception:
            pass

    # ✅ FIX 1: Reduced cache timeout to 5 seconds so new posts appear almost instantly
    ck = f"posts:feed:{page}:{per_page}:{current_user_id}"
    cached = cache.get(ck)
    if cached: return jsonify(cached)

    offset = (page - 1) * per_page
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        if current_user_id:
            query = """
                SELECT p.id, p.content, p.image, p.video, p.like_count, p.comment_count, p.repost_count,
                       p.visibility, u.username, u.profile_picture,
                       CASE WHEN sp.id IS NOT NULL THEN TRUE ELSE FALSE END as is_saved
                FROM posts p
                JOIN users u ON u.id = p.user_id
                LEFT JOIN saved_posts sp ON sp.post_id = p.id AND sp.user_id = %s
                WHERE
                    p.visibility = 'public'
                    OR (p.visibility = 'private' AND p.user_id = %s)
                    OR (
                        p.visibility = 'friends' AND (
                            p.user_id = %s
                            OR EXISTS (
                                SELECT 1 FROM follows f 
                                WHERE f.follower_id = %s AND f.following_id = p.user_id
                            )
                        )
                    )
                ORDER BY p.created_at DESC
                LIMIT %s OFFSET %s
            """
            cur.execute(query, (current_user_id, current_user_id, current_user_id, current_user_id, per_page, offset))
        else:
            cur.execute(
                "SELECT p.id, p.content, p.image, p.video, p.like_count, p.comment_count, p.repost_count, "
                "p.visibility, u.username, u.profile_picture, FALSE as is_saved "
                "FROM posts p JOIN users u ON u.id = p.user_id "
                "WHERE p.visibility = 'public' ORDER BY p.created_at DESC LIMIT %s OFFSET %s",
                (per_page, offset)
            )
        
        result = [_serialize_post(r) for r in cur.fetchall()]
        cache.set(ck, result, timeout=5) # ✅ Cache for only 5 seconds
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)
@app.route("/like_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def like_post():
    post_id = (request.json or {}).get("post_id")
    if not post_id: return jsonify({"msg": "post_id_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT 1 FROM likes WHERE user_id=%s AND post_id=%s", (user_id, post_id))
        if cur.fetchone():
            cur.execute("DELETE FROM likes WHERE user_id=%s AND post_id=%s", (user_id, post_id))
            cur.execute("UPDATE posts SET like_count=GREATEST(like_count-1,0) WHERE id=%s", (post_id,))
            liked = False
        else:
            cur.execute("INSERT INTO likes (user_id,post_id) VALUES (%s,%s)", (user_id, post_id))
            cur.execute("UPDATE posts SET like_count=like_count+1 WHERE id=%s", (post_id,))
            liked = True
            
            cur.execute("SELECT user_id FROM posts WHERE id=%s", (post_id,))
            post_owner = cur.fetchone()[0]
            create_notification(post_owner, user_id, 'like', post_id)
        conn.commit()
        invalidate_feed_cache()
        return jsonify({"msg": "done", "liked": liked})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Like: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/repost_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def repost_post():
    post_id = (request.json or {}).get("post_id")
    if not post_id: return jsonify({"msg": "post_id_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT 1 FROM reposts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
        if cur.fetchone():
            cur.execute("DELETE FROM reposts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
            cur.execute("UPDATE posts SET repost_count=GREATEST(repost_count-1,0) WHERE id=%s", (post_id,))
        else:
            cur.execute("INSERT INTO reposts (user_id,post_id) VALUES (%s,%s)", (user_id, post_id))
            cur.execute("UPDATE posts SET repost_count=repost_count+1 WHERE id=%s", (post_id,))
        
        conn.commit()
        invalidate_feed_cache()
        return jsonify({"msg": "done"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Repost: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/delete_post/<int:post_id>", methods=["DELETE"])
@token_required
def delete_post(post_id):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT user_id,image,video FROM posts WHERE id=%s", (post_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        
        owner_id, img_field, vid = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id:
            return jsonify({"msg": "unauthorized"}), 403
        
        # Delete all images from Cloudinary
        for img_url in parse_images(img_field):
            executor.submit(delete_asset_bg, img_url, "image")
        if vid: executor.submit(delete_asset_bg, vid, "video")
        
        cur.execute("DELETE FROM posts WHERE id=%s", (post_id,))
        conn.commit()
        invalidate_feed_cache()
        return jsonify({"msg": "deleted"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Delete post: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/edit_post/<int:post_id>", methods=["PUT"])
@token_required
def edit_post(post_id):
    content = request.form.get("content")
    image = request.files.get("image")
    visibility = request.form.get("visibility")
    
    if not content and not image and not visibility:
        return jsonify({"msg": "nothing_to_update"}), 400

    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT user_id, image FROM posts WHERE id=%s", (post_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        
        owner_id, old_img_field = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id:
            return jsonify({"msg": "unauthorized"}), 403

        updates, params = [], []
        if content is not None:
            updates.append("content = %s"); params.append(content)
        if visibility and visibility in ('public', 'private', 'friends'):
            updates.append("visibility = %s"); params.append(visibility)

        if image and image.filename:
            res = cloudinary.uploader.upload(image)
            new_img = res["secure_url"]
            for old_url in parse_images(old_img_field):
                if "unknown" not in old_url:
                    executor.submit(delete_asset_bg, old_url, "image")
            updates.append("image = %s"); params.append(new_img)

        if updates:
            params.append(post_id)
            cur.execute(f"UPDATE posts SET {', '.join(updates)} WHERE id = %s", params)
            conn.commit()
            invalidate_feed_cache()

        return jsonify({"msg": "updated"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Edit post: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

# ─────────────────────────────────────────────────────────────
# Comments Routes
# ─────────────────────────────────────────────────────────────
@app.route("/get_comments/<int:post_id>", methods=["GET"])
def get_comments(post_id):
    ck = f"comments:{post_id}"
    cached = cache.get(ck)
    if cached: return jsonify(cached)
    
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        cur.execute(
            "SELECT c.id,c.content,c.created_at,u.username,u.name,u.profile_picture "
            "FROM comments c JOIN users u ON c.user_id=u.id "
            "WHERE c.post_id=%s ORDER BY c.created_at ASC LIMIT 100",
            (post_id,)
        )
        result = [
            {"id": r[0], "content": r[1], "created_at": str(r[2]),
             "username": r[3], "name": r[4], "profile_picture": r[5]}
            for r in cur.fetchall()
        ]
        cache.set(ck, result, timeout=60)
        return jsonify(result)
    finally:
        cur.close(); release_conn(conn)

@app.route("/add_comment", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_comment():
    data = request.json or {}
    post_id = data.get("post_id")
    content = data.get("content", "").strip()
    
    if not post_id or not content:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("INSERT INTO comments (post_id,user_id,content) VALUES (%s,%s,%s)", (post_id, user_id, content))
        cur.execute("UPDATE posts SET comment_count=comment_count+1 WHERE id=%s", (post_id,))
        conn.commit()
        cur.execute("SELECT user_id FROM posts WHERE id=%s", (post_id,))
        post_owner = cur.fetchone()[0]
        create_notification(post_owner, user_id, 'comment', post_id)
        cache.delete(f"comments:{post_id}")
        return jsonify({"msg": "comment_added"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Add comment: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/delete_comment/<int:comment_id>", methods=["DELETE"])
@token_required
def delete_comment(comment_id):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT post_id,user_id FROM comments WHERE id=%s", (comment_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        
        post_id, owner_id = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("DELETE FROM comments WHERE id=%s", (comment_id,))
        cur.execute("UPDATE posts SET comment_count=GREATEST(comment_count-1,0) WHERE id=%s", (post_id,))
        conn.commit()
        cache.delete(f"comments:{post_id}")
        return jsonify({"msg": "deleted"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Delete comment: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/edit_comment/<int:comment_id>", methods=["PUT"])
@token_required
def edit_comment(comment_id):
    content = (request.json or {}).get("content", "").strip()
    if not content:
        return jsonify({"msg": "content_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT post_id,user_id FROM comments WHERE id=%s", (comment_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        
        post_id, owner_id = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("UPDATE comments SET content=%s WHERE id=%s", (content, comment_id))
        conn.commit()
        cache.delete(f"comments:{post_id}")
        return jsonify({"msg": "updated"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Edit comment: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

# ─────────────────────────────────────────────────────────────
# Follows Routes
# ─────────────────────────────────────────────────────────────
@app.route("/follow", methods=["POST"])
@token_required
@limiter.limit("20 per minute")
def follow():
    target = (request.json or {}).get("username")
    if not target:
        return jsonify({"msg": "invalid_target"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT id FROM users WHERE username=%s", (target,))
        t_row = cur.fetchone()
        if not t_row: return jsonify({"msg": "user_not_found"}), 404
        
        target_id = t_row[0]
        if target_id == user_id:
            return jsonify({"msg": "invalid_target"}), 400
        
        cur.execute("SELECT 1 FROM follows WHERE follower_id=%s AND following_id=%s", (user_id, target_id))
        if cur.fetchone():
            cur.execute("DELETE FROM follows WHERE follower_id=%s AND following_id=%s", (user_id, target_id))
            conn.commit()
            cur.execute("SELECT 1 FROM follows WHERE follower_id=%s AND following_id=%s", (target_id, user_id))
            status = "friends" if cur.fetchone() else "none"
            return jsonify({"msg": "unfollowed", "status": status})
        else:
            cur.execute("INSERT INTO follows (follower_id,following_id) VALUES (%s,%s)", (user_id, target_id))
            conn.commit()
            cur.execute("SELECT 1 FROM follows WHERE follower_id=%s AND following_id=%s", (target_id, user_id))
            status = "friends" if cur.fetchone() else "following"
            
            create_notification(target_id, user_id, 'follow')
            return jsonify({"msg": "followed", "status": status})
            
    except Exception as e:
        conn.rollback(); logger.error(f"Follow: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_friends", methods=["GET"])
@token_required
def get_friends():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        
        ck = user_cache_key("friends", user_id)
        cached = cache.get(ck)
        if cached: return jsonify(cached)
        
        cur.execute(
            "SELECT u.id,u.username,u.name,u.profile_picture,"
            "CASE WHEN u.last_seen > NOW() - INTERVAL '30 seconds' THEN true ELSE false END "
            "FROM users u WHERE u.id != %s "
            "AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id=%s AND f1.following_id=u.id) "
            "AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s)",
            (user_id, user_id, user_id)
        )
        result = [{"id":r[0],"username":r[1],"name":r[2],"profile_picture":r[3],"is_online":r[4]} for r in cur.fetchall()]
        cache.set(ck, result, timeout=30)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

@app.route("/my_follows", methods=["GET"])
@token_required
def get_my_follows():
    conn = get_conn()
    if not conn: return jsonify({"following":[],"friends":[]}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        ck = user_cache_key("my_follows", user_id)
        cached = cache.get(ck)
        if cached: return jsonify(cached)
        
        cur.execute(
            "SELECT u.username, EXISTS ("
            "  SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s"
            ") as is_mutual "
            "FROM users u JOIN follows f ON f.following_id=u.id WHERE f.follower_id=%s",
            (user_id, user_id)
        )
        following, friends = [], []
        for uname, is_mutual in cur.fetchall():
            (friends if is_mutual else following).append(uname)
        
        result = {"following": following, "friends": friends}
        cache.set(ck, result, timeout=60)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_my_info", methods=["GET"])
@token_required
def get_my_info():
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        ck = user_cache_key("my_info", user_id or str(g.user_id))
        cached = cache.get(ck)
        if cached: return jsonify(cached)
        
        if user_id:
            cur.execute("SELECT username,name,email,phone,profile_picture FROM users WHERE id=%s", (user_id,))
        else:
            cur.execute("SELECT username,name,email,phone,profile_picture FROM users WHERE username=%s", (str(g.user_id),))
        
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 404
        
        result = {"username":user[0],"name":user[1],"email":user[2],"phone":user[3],"profile_picture":user[4]}
        cache.set(ck, result, timeout=120)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

@app.route("/update_profile", methods=["POST"])
@token_required
@limiter.limit("10 per minute")
def update_profile():
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if user_id:
            cur.execute("SELECT id,name,email,phone,username,password,profile_picture FROM users WHERE id=%s", (user_id,))
        else:
            cur.execute("SELECT id,name,email,phone,username,password,profile_picture FROM users WHERE username=%s", (str(g.user_id),))
        
        user = cur.fetchone()
        if not user: return jsonify({"msg": "user_not_found"}), 404
        
        uid, old_name, old_email, old_phone, old_user, old_pass, old_pic = user
        new_name  = request.form.get("name", "").strip() or old_name
        new_user  = request.form.get("username", "").strip() or old_user
        new_email = request.form.get("email", "").strip() or None
        new_phone = request.form.get("phone", "").strip() or None
        old_pw    = request.form.get("old_password", "").strip()
        new_pw    = request.form.get("new_password", "").strip()

        if new_user != old_user:
            cur.execute("SELECT 1 FROM users WHERE username=%s AND id!=%s", (new_user, uid))
            if cur.fetchone(): return jsonify({"msg": "username_taken"}), 409
        if new_email and new_email != old_email:
            cur.execute("SELECT 1 FROM users WHERE email=%s AND id!=%s", (new_email, uid))
            if cur.fetchone(): return jsonify({"msg": "email_used"}), 409
        if new_phone and new_phone != old_phone:
            cur.execute("SELECT 1 FROM users WHERE phone=%s AND id!=%s", (new_phone, uid))
            if cur.fetchone(): return jsonify({"msg": "phone_used"}), 409

        new_pic = old_pic
        img = request.files.get("profile_image")
        if img and img.filename:
            res = cloudinary.uploader.upload(img)
            new_pic = res["secure_url"]
            if old_pic and "unknown" not in old_pic:
                executor.submit(delete_asset_bg, old_pic, "image")

        updates, params = [], []
        if new_name != old_name:   updates.append("name=%s");             params.append(new_name)
        if new_user != old_user:   updates.append("username=%s");          params.append(new_user)
        if new_email != old_email: updates.append("email=%s");             params.append(new_email)
        if new_phone != old_phone: updates.append("phone=%s");             params.append(new_phone)
        if new_pic != old_pic:     updates.append("profile_picture=%s");   params.append(new_pic)

        if new_pw:
            if old_pass != "google_auth" and not _verify_password(old_pw, old_pass):
                return jsonify({"msg": "old_password_incorrect"}), 400
            if len(new_pw) < 6:
                return jsonify({"msg": "password_too_short"}), 400
            updates.append("password=%s"); params.append(_hash_password(new_pw))

        if updates:
            params.append(uid)
            cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=%s", params)
            conn.commit()

        cache.delete(user_cache_key("my_info", uid))
        return jsonify({"msg": "updated", "username": new_user, "profile_picture": new_pic, "name": new_name})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Update profile: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

# ─────────────────────────────────────────────────────────────
# User Profile Routes
# ─────────────────────────────────────────────────────────────
@app.route("/user/<username>", methods=["GET"])
def get_user_profile(username):
    token = request.headers.get("Authorization", "")
    current_user_id = None
    
    if token:
        try:
            token_clean = token.replace("Bearer ", "").strip()
            data = jwt.decode(token_clean, app.secret_key, algorithms=["HS256"])
            user_val = data.get("user_id") or data.get("user")
            if user_val:
                conn_temp = get_conn()
                if conn_temp:
                    cur_temp = conn_temp.cursor()
                    try:
                        current_user_id = resolve_user_id(cur_temp, user_val)
                    finally:
                        cur_temp.close(); release_conn(conn_temp)
        except Exception:
            pass

    ck = f"profile:{username}:{current_user_id}"
    cached = cache.get(ck)
    if cached: return jsonify(cached)

    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id,username,name,profile_picture FROM users WHERE username=%s", (username,))
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 404
        uid = user[0]

        cur.execute("SELECT COUNT(*) FROM follows WHERE following_id=%s", (uid,))
        followers = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM follows WHERE follower_id=%s", (uid,))
        following = cur.fetchone()[0]

        if current_user_id:
            if int(current_user_id) == int(uid):
                cur.execute("""
                    SELECT p.id,p.content,p.image,p.video,p.like_count,p.comment_count,p.repost_count,
                           p.visibility,p.created_at,u.username,u.profile_picture
                    FROM posts p JOIN users u ON p.user_id=u.id
                    WHERE p.user_id=%s ORDER BY p.created_at DESC LIMIT 50
                """, (uid,))
            else:
                cur.execute("""
                    SELECT p.id,p.content,p.image,p.video,p.like_count,p.comment_count,p.repost_count,
                           p.visibility,p.created_at,u.username,u.profile_picture
                    FROM posts p JOIN users u ON p.user_id=u.id
                    WHERE p.user_id=%s AND (
                        p.visibility = 'public'
                        OR (p.visibility = 'friends'
                            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id=%s AND f1.following_id=%s)
                            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=%s AND f2.following_id=%s)
                        )
                    )
                    ORDER BY p.created_at DESC LIMIT 50
                """, (uid, current_user_id, uid, uid, current_user_id))
        else:
            cur.execute("""
                SELECT p.id,p.content,p.image,p.video,p.like_count,p.comment_count,p.repost_count,
                       p.visibility,p.created_at,u.username,u.profile_picture
                FROM posts p JOIN users u ON p.user_id=u.id
                WHERE p.user_id=%s AND p.visibility = 'public'
                ORDER BY p.created_at DESC LIMIT 50
            """, (uid,))

        posts = []
        for p in cur.fetchall():
            images = parse_images(p[2])
            posts.append({
                "id":p[0],"content":p[1],
                "image": images[0] if len(images)==1 else (images[0] if images else None),
                "images": images,
                "video":p[3],
                "likes":p[4],"comments":p[5],"reposts":p[6],
                "visibility":p[7],"created_at":str(p[8]),
                "username":p[9],"profile_picture":p[10]
            })

        result = {
            "id": user[0], "username": user[1], "name": user[2], "profile_picture": user[3],
            "followers": followers, "following": following, "posts": posts
        }
        cache.set(ck, result, timeout=60)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

@app.route("/search_users", methods=["GET"])
@token_required
def search_users():
    query = request.args.get("q", "").strip().lower()
    ck = f"search_users:{query}"
    cached = cache.get(ck)
    if cached: return jsonify(cached)
    
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        if query:
            cur.execute(
                "SELECT username,name,profile_picture FROM users "
                "WHERE username ILIKE %s OR name ILIKE %s ORDER BY username LIMIT 20",
                (f"%{query}%", f"%{query}%")
            )
        else:
            cur.execute("SELECT username,name,profile_picture FROM users ORDER BY username LIMIT 20")
        
        result = [{"username":r[0],"name":r[1],"profile_picture":r[2]} for r in cur.fetchall()]
        cache.set(ck, result, timeout=120)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_friends_list", methods=["GET"])
@token_required
def get_friends_list():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        
        ck = user_cache_key("friends_list", user_id)
        cached = cache.get(ck)
        if cached: return jsonify(cached)
        
        cur.execute(
            "SELECT u.id,u.username,u.name,u.profile_picture,"
            "CASE WHEN u.last_seen > NOW() - INTERVAL '60 seconds' THEN true ELSE false END "
            "FROM users u WHERE u.id != %s "
            "AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id=%s AND f1.following_id=u.id) "
            "AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s) "
            "ORDER BY u.last_seen DESC",
            (user_id, user_id, user_id)
        )
        result = [{"id":r[0],"username":r[1],"name":r[2],"profile_picture":r[3],"is_online":r[4]} for r in cur.fetchall()]
        cache.set(ck, result, timeout=20)
        return jsonify(result)
        
    finally:
        cur.close(); release_conn(conn)

# ─────────────────────────────────────────────────────────────
# Messages Routes
# ─────────────────────────────────────────────────────────────
@app.route("/get_conversations", methods=["GET"])
@token_required
def get_conversations():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        
        ck = user_cache_key("conversations", user_id)
        cached = cache.get(ck)
        if cached: return jsonify(cached)
        
        cur.execute("""
            WITH conv AS (
                SELECT CASE WHEN sender_id=%s THEN receiver_id ELSE sender_id END AS other_id,
                       MAX(created_at) AS last_time,
                       COUNT(CASE WHEN receiver_id=%s AND is_read=FALSE THEN 1 END) AS unread_count
                FROM messages WHERE sender_id=%s OR receiver_id=%s
                GROUP BY other_id ORDER BY last_time DESC LIMIT 50
            ),
            last_msgs AS (
                SELECT DISTINCT ON (CASE WHEN sender_id=%s THEN receiver_id ELSE sender_id END)
                       CASE WHEN sender_id=%s THEN receiver_id ELSE sender_id END AS other_id,
                       content, sender_id, created_at
                FROM messages WHERE sender_id=%s OR receiver_id=%s
                ORDER BY other_id, created_at DESC
            )
            SELECT c.other_id, u.username, u.name, u.profile_picture, c.last_time, c.unread_count,
                   lm.content, lm.sender_id,
                   CASE WHEN u.last_seen > NOW() - INTERVAL '30 seconds' THEN TRUE ELSE FALSE END AS is_online
            FROM conv c
            JOIN users u ON u.id = c.other_id
            LEFT JOIN last_msgs lm ON lm.other_id = c.other_id
            ORDER BY c.last_time DESC
        """, (user_id,)*8)
        
        convs = []
        for row in cur.fetchall():
            other_id, uname, name, pic, last_time, unread, last_content, last_sender, is_online = row
            convs.append({
                "user_id": other_id, "username": uname, "name": name, "profile_picture": pic,
                "last_message_time": str(last_time), "last_message": last_content or "",
                "last_message_from_me": last_sender == user_id,
                "unread_count": unread, "is_online": bool(is_online)
            })
        
        cache.set(ck, convs, timeout=15)
        return jsonify(convs)
        
    except Exception as e:
        logger.error(f"Get conversations: {e}")
        return jsonify([]), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_messages/<string:other_username>", methods=["GET"])
@token_required
def get_messages(other_username):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        
        cur.execute("SELECT id,profile_picture FROM users WHERE username=%s", (other_username,))
        other = cur.fetchone()
        if not other: return jsonify({"msg": "user_not_found"}), 404
        other_id, other_pic = other
        
        cur.execute(
            "UPDATE messages SET is_read=TRUE WHERE sender_id=%s AND receiver_id=%s AND is_read=FALSE",
            (other_id, user_id)
        )
        conn.commit()
        cache.delete(user_cache_key("conversations", user_id))

        cur.execute("""
            SELECT
                m.id, m.content, m.created_at, m.sender_id, m.reply_to_id,
                u.username, u.profile_picture,
                r.id, r.content, r.sender_id, ru.username,
                m.is_edited, m.media_url, m.media_type, m.media_name,
                m.media_size, m.media_thumbnail, m.hidden_by, m.deleted_status
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            LEFT JOIN messages r ON m.reply_to_id = r.id
            LEFT JOIN users ru ON r.sender_id = ru.id
            WHERE
                (
                    (m.sender_id = %s AND m.receiver_id = %s)
                    OR (m.sender_id = %s AND m.receiver_id = %s)
                )
                AND m.deleted_status != 'deleted_everyone'
                AND NOT (%s = ANY(COALESCE(m.hidden_by, '{}')))
            ORDER BY m.created_at ASC
            LIMIT 100
        """, (user_id, other_id, other_id, user_id, user_id))

        rows = cur.fetchall()
        if not rows:
            return jsonify({"messages": [], "other_user_picture": other_pic})

        msg_ids = [r[0] for r in rows]
        cur.execute(
            "SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id = ANY(%s)",
            (msg_ids,)
        )
        from collections import defaultdict
        reactions_by_msg = defaultdict(list)
        for msg_id, emoji, react_uid in cur.fetchall():
            reactions_by_msg[msg_id].append((emoji, react_uid))

        msgs = []
        for row in rows:
            mid = row[0]
            msg_reactions = reactions_by_msg.get(mid, [])
            counts = {}
            user_reacts = []
            for emoji, react_uid in msg_reactions:
                counts[emoji] = counts.get(emoji, 0) + 1
                if react_uid == user_id:
                    user_reacts.append(emoji)
            msgs.append({
                "id": mid, "content": row[1], "created_at": str(row[2]),
                "sender_id": row[3], "reply_to_id": row[4],
                "sender_username": row[5], "sender_picture": row[6],
                "is_mine": row[3] == user_id,
                "reply_context": {
                    "id": row[7], "content": row[8],
                    "sender_id": row[9], "sender_username": row[10]
                } if row[7] else None,
                "reactions": counts, "user_reactions": user_reacts,
                "is_edited": row[11] if len(row) > 11 else False,
                "media_url": row[12], "media_type": row[13],
                "media_name": row[14], "media_size": row[15],
                "media_thumbnail": row[16],
                "hidden_by": row[17] or [], "deleted_status": row[18] or "active"
            })
        return jsonify({"messages": msgs, "other_user_picture": other_pic})
        
    except Exception as e:
        logger.error(f"Get messages: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/send_message", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def send_message():
    data = request.json or {}
    receiver = data.get("receiver_username")
    content = data.get("content", "").strip()
    
    if not receiver or not content:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        sender_id = resolve_user_id(cur, g.user_id)
        if not sender_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT id FROM users WHERE username=%s", (receiver,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "user_not_found"}), 404
        receiver_id = row[0]
        
        reply_to = data.get("reply_to_id")
        cur.execute(
            "INSERT INTO messages (sender_id,receiver_id,content,reply_to_id) VALUES (%s,%s,%s,%s)",
            (sender_id, receiver_id, content, reply_to)
        )
        conn.commit()
        cache.delete(user_cache_key("conversations", sender_id))
        cache.delete(user_cache_key("conversations", receiver_id))
        return jsonify({"msg": "sent"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Send message: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/send_media_message", methods=["POST"])
@token_required
@limiter.limit("10 per minute")
def send_media_message():
    if 'media' not in request.files:
        return jsonify({"msg": "no_media"}), 400
    
    receiver   = request.form.get("receiver_username")
    content    = request.form.get("content", "").strip()
    media_file = request.files['media']
    reply_to_id = request.form.get("reply_to_id", type=int)
    
    if not receiver or media_file.filename == '':
        return jsonify({"msg": "missing_fields"}), 400

    ALLOWED_TYPES = {
        'image': ['image/jpeg','image/png','image/webp','image/gif'],
        'video': ['video/mp4','video/webm'],
        'file':  ['application/pdf','application/msword',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  'application/vnd.ms-excel',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'application/vnd.ms-powerpoint',
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  'text/plain','application/zip',
                  'application/x-rar-compressed','application/x-7z-compressed']
    }
    MAX_SIZES = {'image': 10*1024*1024, 'video': 25*1024*1024, 'file': 15*1024*1024}

    mime = media_file.content_type
    media_type = next((t for t, mimes in ALLOWED_TYPES.items() if mime in mimes), None)
    if not media_type:
        return jsonify({"msg": "invalid_media_type"}), 400
    if media_file.content_length and media_file.content_length > MAX_SIZES.get(media_type, 10*1024*1024):
        return jsonify({"msg": "file_too_large"}), 400

    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        sid = resolve_user_id(cur, g.user_id)
        if not sid: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT id FROM users WHERE username=%s", (receiver,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "user_not_found"}), 404
        rid = row[0]

        upload_params = {'folder': 'socialgrid/media', 'use_filename': True, 'unique_filename': True, 'overwrite': False}
        if media_type == 'image':
            upload_params.update({'transformation': [{'width':1920,'height':1920,'crop':'limit'},{'quality':'auto:good'},{'fetch_format':'auto'}]})
        elif media_type == 'video':
            upload_params.update({'resource_type':'video','transformation':[{'width':1280,'height':720,'crop':'limit'},{'video_codec':'auto'},{'quality':'auto:good'}]})
        elif media_type == 'file':
            upload_params.update({'resource_type':'raw'})

        upload_result = cloudinary.uploader.upload(media_file, **upload_params)
        thumbnail = None
        if media_type == 'image':
            try:
                thumbnail = cloudinary.utils.cloudinary_url(upload_result['public_id'],
                    transformation=[{'width':150,'height':150,'crop':'thumb','quality':'auto'}])[0]
            except:
                thumbnail = upload_result['secure_url']

        cur.execute("""
            INSERT INTO messages (sender_id,receiver_id,content,reply_to_id,media_url,media_type,media_name,media_size,media_thumbnail)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (sid, rid, content or "", reply_to_id, upload_result['secure_url'],
              media_type, media_file.filename, media_file.content_length or 0, thumbnail))
        conn.commit()
        cache.delete(user_cache_key("conversations", sid))
        cache.delete(user_cache_key("conversations", rid))
        return jsonify({"msg":"sent","media_url":upload_result['secure_url'],"media_type":media_type,"thumbnail":thumbnail}), 200
        
    except Exception as e:
        conn.rollback()
        logger.error(f"send_media_message FAILED: {type(e).__name__}: {str(e)}")
        return jsonify({"msg":"upload_failed","error":"server_error"}), 500
    finally:
        cur.close(); release_conn(conn)

# ══════════════════════════════════════════════════════════════
# 🖼️ NEW: Send Multiple Images in One Request
# ══════════════════════════════════════════════════════════════
@app.route("/send_multi_image_message", methods=["POST"])
@token_required
@limiter.limit("5 per minute")
def send_multi_image_message():
    """Send multiple images in one request (each as separate message)"""
    try:
        images_json = request.form.get("images_json")
        receiver = request.form.get("receiver_username")
        content = request.form.get("content", "").strip()
        reply_to_id = request.form.get("reply_to_id", type=int)
        
        logger.info(f"📥 send_multi_image_message: receiver={receiver}, images_json_len={len(images_json) if images_json else 0}")
        
        if not images_json or not receiver:
            return jsonify({"msg": "missing_fields"}), 400
        
        try:
            image_urls = json.loads(images_json)
            if not isinstance(image_urls, list) or not image_urls:
                raise ValueError("images_json must be a non-empty list")
        except (json.JSONDecodeError, ValueError) as e:
            return jsonify({"msg": f"invalid_images_json: {str(e)}"}), 400
        
        conn = get_conn()
        if not conn:
            return jsonify({"msg": "db_error"}), 503
        
        cur = conn.cursor()
        
        try:
            sid = resolve_user_id(cur, g.user_id)
            if not sid:
                return jsonify({"msg": "user_not_found"}), 404
            
            cur.execute("SELECT id FROM users WHERE username=%s", (receiver,))
            row = cur.fetchone()
            if not row:
                return jsonify({"msg": "user_not_found"}), 404
            rid = row[0]
            
            inserted_count = 0
            for i, img_url in enumerate(image_urls):
                # ✅ FIX: Use "" for content if None/empty, to satisfy NOT NULL constraint
                msg_content = content if i == 0 and content else ""
                msg_reply = reply_to_id if i == 0 else None
                
                cur.execute("""
                    INSERT INTO messages (
                        sender_id, receiver_id, content, reply_to_id,
                        media_url, media_type, media_name, media_size, media_thumbnail
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    sid, rid, msg_content, msg_reply,
                    img_url, 'image', f'image_{i+1}.jpg', 0, img_url
                ))
                inserted_count += 1
            
            conn.commit()
            logger.info(f"✅ Inserted {inserted_count} messages")
            
            try:
                cache.delete(user_cache_key("conversations", sid))
                cache.delete(user_cache_key("conversations", rid))
            except Exception as cache_err:
                logger.warning(f"⚠️ Cache warning: {cache_err}")
            
            return jsonify({"msg": "sent", "count": inserted_count}), 200
            
        except Exception as db_err:
            conn.rollback()
            logger.error(f"❌ DB error: {type(db_err).__name__}: {db_err}")
            return jsonify({"msg": f"db_error: {str(db_err)}"}), 500
        finally:
            cur.close()
            release_conn(conn)
            
    except Exception as e:
        logger.error(f"❌ Unexpected error: {type(e).__name__}: {e}", exc_info=True)
        return jsonify({"msg": f"server_error: {str(e)}"}), 500

@app.route("/delete_message/<string:message_id>", methods=["POST"])
@token_required
def delete_message(message_id):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        uid = resolve_user_id(cur, g.user_id)
        if not uid: return jsonify({"msg": "user_not_found"}), 404
        
        try:
            numeric_id = int(str(message_id).replace("id-", ""))
        except (ValueError, AttributeError):
            return jsonify({"msg": "invalid_message_id"}), 400

        cur.execute("SELECT sender_id,receiver_id,media_url,media_type FROM messages WHERE id=%s", (numeric_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        
        sender_id, receiver_id, media_url, media_type = int(row[0]), int(row[1]), row[2], row[3]
        
        if int(uid) not in [sender_id, receiver_id]:
            return jsonify({"msg": "unauthorized"}), 403
        
        data = request.json or {}
        delete_scope = data.get("delete_for", "me")

        if delete_scope == "everyone":
            if sender_id != int(uid):
                return jsonify({"msg": "only_sender_can_delete_for_everyone"}), 403
            if media_url and "unknown" not in media_url:
                executor.submit(delete_asset_bg, media_url, media_type or "image")
            cur.execute("""
                UPDATE messages SET content='🗑️ This message was deleted',
                    deleted_status='deleted_everyone',
                    media_url=NULL,media_type=NULL,media_name=NULL,media_thumbnail=NULL
                WHERE id=%s
            """, (numeric_id,))
        else:
            cur.execute("""
                UPDATE messages SET hidden_by =
                    CASE WHEN %s = ANY(COALESCE(hidden_by,'{}')) THEN hidden_by
                         ELSE array_append(COALESCE(hidden_by,'{}'), %s) END
                WHERE id=%s
            """, (int(uid), int(uid), numeric_id))

        conn.commit()
        cache.delete(user_cache_key("conversations", sender_id))
        if receiver_id: cache.delete(user_cache_key("conversations", receiver_id))
        return jsonify({"msg": "deleted", "scope": delete_scope}), 200
        
    except Exception as e:
        conn.rollback(); logger.error(f"delete_message: {e}")
        return jsonify({"msg":"error","detail":str(e)}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/edit_message/<string:message_id>", methods=["PUT"])
@token_required
@limiter.limit("20 per minute")
def edit_message(message_id):
    content = (request.json or {}).get("content", "").strip()
    if not content: return jsonify({"msg": "content_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        try:
            numeric_id = int(str(message_id).replace("id-", ""))
        except (ValueError, AttributeError):
            return jsonify({"msg": "invalid_message_id"}), 400
        
        sender_id = resolve_user_id(cur, g.user_id)
        if not sender_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT sender_id,deleted_status FROM messages WHERE id=%s", (numeric_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        if int(row[0]) != int(sender_id): return jsonify({"msg": "unauthorized"}), 403
        if row[1] == 'deleted_everyone': return jsonify({"msg": "message_deleted"}), 400
        
        cur.execute("UPDATE messages SET content=%s,is_edited=TRUE WHERE id=%s", (content, numeric_id))
        conn.commit()
        return jsonify({"msg": "updated"}), 200
        
    except Exception as e:
        conn.rollback(); logger.error(f"Edit message: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/add_reaction", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_reaction():
    data = request.json or {}
    message_id = data.get("message_id")
    emoji = data.get("emoji")
    
    if not message_id or not emoji: return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT 1 FROM messages WHERE id=%s", (message_id,))
        if not cur.fetchone(): return jsonify({"msg": "not_found"}), 404
        
        cur.execute("INSERT INTO message_reactions (message_id,user_id,emoji) VALUES (%s,%s,%s)", (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_added"})
        
    except Exception as e:
        conn.rollback()
        if "unique" in str(e).lower(): return jsonify({"msg": "already_reacted"}), 409
        logger.error(f"Add reaction: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/remove_reaction", methods=["POST"])
@token_required
def remove_reaction():
    data = request.json or {}
    message_id = data.get("message_id")
    emoji = data.get("emoji")
    
    if not message_id or not emoji: return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("DELETE FROM message_reactions WHERE message_id=%s AND user_id=%s AND emoji=%s", (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_removed"})
        
    except Exception as e:
        conn.rollback(); logger.error(f"Remove reaction: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/delete_conversation/<string:username>", methods=["POST"])
@token_required
def delete_conversation(username):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        uid = resolve_user_id(cur, g.user_id)
        if not uid: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT id FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "user_not_found"}), 404
        other_id = row[0]
        
        data = request.json or {}
        delete_scope = data.get("delete_for", "me")
        
        if delete_scope == "everyone":
            cur.execute(
                "SELECT media_url,media_type FROM messages WHERE (sender_id=%s AND receiver_id=%s) OR (sender_id=%s AND receiver_id=%s)",
                (uid, other_id, other_id, uid)
            )
            for media_url, media_type in cur.fetchall():
                if media_url and "unknown" not in media_url:
                    executor.submit(delete_asset_bg, media_url, media_type or "image")
            cur.execute(
                "DELETE FROM messages WHERE (sender_id=%s AND receiver_id=%s) OR (sender_id=%s AND receiver_id=%s)",
                (uid, other_id, other_id, uid)
            )
        else:
            cur.execute("""
                UPDATE messages SET hidden_by =
                    CASE WHEN %s = ANY(COALESCE(hidden_by,'{}')) THEN hidden_by
                         ELSE array_append(COALESCE(hidden_by,'{}'), %s) END
                WHERE (sender_id=%s AND receiver_id=%s) OR (sender_id=%s AND receiver_id=%s)
            """, (uid, uid, uid, other_id, other_id, uid))
        
        conn.commit()
        cache.delete(user_cache_key("conversations", uid))
        cache.delete(user_cache_key("conversations", other_id))
        return jsonify({"msg":"conversation_deleted","scope":delete_scope}), 200
        
    except Exception as e:
        conn.rollback(); logger.error(f"delete_conversation: {e}")
        return jsonify({"msg":"error","detail":str(e)}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_user_status/<username>", methods=["GET"])
@token_required
def get_user_status(username):
    conn = get_conn()
    if not conn: return jsonify({"is_online": False}), 503
    cur = conn.cursor()
    
    try:
        cur.execute(
            "SELECT CASE WHEN last_seen > NOW() - INTERVAL '30 seconds' THEN TRUE ELSE FALSE END "
            "FROM users WHERE username=%s", (username,)
        )
        row = cur.fetchone()
        return jsonify({"is_online": bool(row[0]) if row else False})
    finally:
        cur.close(); release_conn(conn)
def create_notification(receiver_id, actor_id, notif_type, post_id=None):
    """Creates a notification if the actor isn't the receiver"""
    if not receiver_id or not actor_id or int(receiver_id) == int(actor_id):
        return
    conn = get_conn()
    if not conn: return
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO notifications (receiver_id, actor_id, type, post_id) VALUES (%s, %s, %s, %s)",
            (receiver_id, actor_id, notif_type, post_id)
        )
        conn.commit()
        cur.close()
    except Exception as e:
        logger.error(f"Notification error: {e}")
    finally:
        release_conn(conn)
# ─────────────────────────────────────────────────────────────
# 🔔 NOTIFICATIONS ROUTES
# ─────────────────────────────────────────────────────────────
@app.route("/get_notifications", methods=["GET"])
@token_required
def get_notifications():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        cur.execute("""
            SELECT n.id, n.type, n.post_id, n.is_read, n.created_at,
                   u.username, u.name, u.profile_picture, p.content
            FROM notifications n
            JOIN users u ON n.actor_id = u.id
            LEFT JOIN posts p ON n.post_id = p.id
            WHERE n.receiver_id = %s
            ORDER BY n.created_at DESC LIMIT 30
        """, (user_id,))
        
        notifs = []
        for r in cur.fetchall():
            notifs.append({
                "id": r[0], "type": r[1], "post_id": r[2], "is_read": r[3],
                "created_at": str(r[4]), "actor_username": r[5], 
                "actor_name": r[6], "actor_pic": r[7], "post_preview": (r[8] or "")[:50]
            })
        return jsonify(notifs)
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_unread_notif_count", methods=["GET"])
@token_required
def get_unread_notif_count():
    conn = get_conn()
    if not conn: return jsonify({"count": 0}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        cur.execute("SELECT COUNT(*) FROM notifications WHERE receiver_id=%s AND is_read=FALSE", (user_id,))
        count = cur.fetchone()[0]
        return jsonify({"count": count})
    finally:
        cur.close(); release_conn(conn)

@app.route("/mark_notifications_read", methods=["POST"])
@token_required
def mark_notifications_read():
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        cur.execute("UPDATE notifications SET is_read=TRUE WHERE receiver_id=%s AND is_read=FALSE", (user_id,))
        conn.commit()
        return jsonify({"msg": "marked_read"})
    finally:
        cur.close(); release_conn(conn)
# ─────────────────────────────────────────────────────────────
# Database Initialization
# ─────────────────────────────────────────────────────────────
def init_db():
    
    conn = get_conn()
    if not conn: return False
    cur = conn.cursor()
    
    try:
        cur.execute("DELETE FROM pending_signups WHERE created_at < NOW() - INTERVAL '1 hour'")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, name TEXT, email TEXT UNIQUE, phone TEXT UNIQUE,
                username TEXT UNIQUE, password TEXT,
                profile_picture TEXT DEFAULT 'unknown', last_seen TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT, image TEXT, video TEXT, created_at TIMESTAMP DEFAULT NOW(),
                like_count INT DEFAULT 0, comment_count INT DEFAULT 0, repost_count INT DEFAULT 0,
                visibility TEXT DEFAULT 'public' CHECK (visibility IN ('public','private','friends'))
            );
            CREATE TABLE IF NOT EXISTS likes (
                id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id,post_id)
            );
            CREATE TABLE IF NOT EXISTS follows (
                id SERIAL PRIMARY KEY, follower_id INT REFERENCES users(id) ON DELETE CASCADE,
                following_id INT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(follower_id,following_id)
            );
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY, post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT, created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS reposts (
                id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id,post_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, sender_id INT REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(),
                is_read BOOLEAN DEFAULT FALSE, is_edited BOOLEAN DEFAULT FALSE,
                reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL,
                media_url TEXT, media_type TEXT, media_name TEXT, media_size BIGINT,
                media_thumbnail TEXT, hidden_by INT[] DEFAULT '{}', deleted_status TEXT DEFAULT 'active'
            );
            CREATE TABLE IF NOT EXISTS message_reactions (
                id SERIAL PRIMARY KEY, message_id INT REFERENCES messages(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                emoji TEXT, created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id,user_id,emoji)
            );
                        CREATE TABLE IF NOT EXISTS saved_posts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, post_id)
            );
            CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_posts(user_id, created_at DESC);
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE;
            ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public';
            ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_visibility_check;
            ALTER TABLE posts ADD CONSTRAINT posts_visibility_check CHECK (visibility IN ('public','private','friends'));
            CREATE INDEX IF NOT EXISTS idx_posts_created        ON posts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_posts_user           ON posts(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_posts_visibility     ON posts(visibility);
            CREATE INDEX IF NOT EXISTS idx_msgs_sender_receiver ON messages(sender_id, receiver_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_msgs_receiver_read   ON messages(receiver_id, is_read) WHERE is_read=FALSE;
            CREATE INDEX IF NOT EXISTS idx_follows              ON follows(follower_id, following_id);
            CREATE INDEX IF NOT EXISTS idx_likes_post           ON likes(post_id);
            CREATE INDEX IF NOT EXISTS idx_reposts_post         ON reposts(post_id);
            CREATE INDEX IF NOT EXISTS idx_comments_post        ON comments(post_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_users_lookup         ON users(username);
            CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
            CREATE INDEX IF NOT EXISTS idx_reactions_msg        ON message_reactions(message_id);
            CREATE INDEX IF NOT EXISTS idx_users_last_seen      ON users(last_seen DESC);
                         CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
                actor_id INT REFERENCES users(id) ON DELETE CASCADE,
                type TEXT, CHECK
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            );
            

            DO $$ 
            BEGIN
                EXECUTE (
                    SELECT 'ALTER TABLE notifications DROP CONSTRAINT ' || conname || ';'
                    FROM pg_constraint
                    WHERE conrelid = 'notifications'::regclass AND contype = 'c'
                );
            EXCEPTION WHEN OTHERS THEN NULL;
            END $$;
            
            CREATE INDEX IF NOT EXISTS idx_notif_receiver ON notifications(receiver_id, is_read, created_at DESC);
        """)
        conn.commit()
        logger.info("✅ Tables & indexes ready")
        return True
        
    except Exception as e:
        conn.rollback(); logger.error(f"DB init: {e}")
        return False
    finally:
        cur.close(); release_conn(conn)
# ─────────────────────────────────────────────────────────────
# 🔖 SAVED POSTS ROUTES
# ─────────────────────────────────────────────────────────────
@app.route("/toggle_save_post", methods=["POST"])
@token_required
def toggle_save_post():
    """Saves a post if not saved, or unsaves it if already saved"""
    data = request.json or {}
    post_id = data.get("post_id")
    if not post_id: return jsonify({"msg": "post_id_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        # Check if already saved
        cur.execute("SELECT 1 FROM saved_posts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
        if cur.fetchone():
            # Unsave
            cur.execute("DELETE FROM saved_posts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
            conn.commit()
            return jsonify({"msg": "unsaved", "saved": False})
        else:
            # Save
            cur.execute("INSERT INTO saved_posts (user_id, post_id) VALUES (%s, %s)", (user_id, post_id))
            conn.commit()
            return jsonify({"msg": "saved", "saved": True})
            
    except Exception as e:
        conn.rollback(); logger.error(f"Toggle save: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close(); release_conn(conn)

@app.route("/get_saved_posts", methods=["GET"])
@token_required
def get_saved_posts():
    """Fetches all posts saved by the current user"""
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("""
            SELECT p.id, p.content, p.image, p.video, p.like_count, p.comment_count, p.repost_count,
                   p.visibility, u.username, u.profile_picture
            FROM saved_posts s
            JOIN posts p ON s.post_id = p.id
            JOIN users u ON p.user_id = u.id
            WHERE s.user_id = %s
            ORDER BY s.created_at DESC
        """, (user_id,))
        
        result = [_serialize_post(r) for r in cur.fetchall()]
        return jsonify(result)
    finally:
        cur.close(); release_conn(conn)
# ─────────────────────────────────────────────────────────────
# App Startup
# ─────────────────────────────────────────────────────────────
init_db_pool()
init_db()
logger.info("🚀 App ready — Multi-image messaging enabled!")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logger.info(f"🎧 Dev server on port {port}")
    app.run(debug=False, host="0.0.0.0", port=port)
