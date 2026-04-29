import os, sys, logging, time, random, datetime, jwt, traceback, signal
from urllib.parse import urlparse
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, g
from flask_cors import CORS
from flask_caching import Cache
from flask_compress import Compress
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from psycopg2 import pool, OperationalError
import cloudinary.uploader, cloudinary.api

# ============ CONFIG ============
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY", "dev-key-change-me")
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB upload limit

# Extensions
CORS(app)
cache = Cache(app, config={'CACHE_TYPE': 'SimpleCache', 'CACHE_DEFAULT_TIMEOUT': 60})
Compress(app)
limiter = Limiter(key_func=get_remote_address, app=app, 
                  default_limits=["120 per minute", "20 per second"],
                  storage_uri="memory://")

# Cloudinary
cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME", "dlimysibj"),
    api_key=os.environ.get("CLOUDINARY_API_KEY", "239576522747935"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET", "sn4KlQ9Q-KwEqjOUxvF-MmO2ln8")
)

# ============ DATABASE POOL ============
_db_pool = None

def init_db_pool():
    global _db_pool
    try:
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            logger.error("❌ DATABASE_URL not set!")
            return False
        result = urlparse(db_url)
        _db_pool = pool.ThreadedConnectionPool(
            minconn=1, maxconn=4,
            host=result.hostname, port=result.port or 5432,
            database=result.path.lstrip('/'),
            user=result.username, password=result.password,
            sslmode='require', connect_timeout=10
        )
        logger.info("✅ DB pool initialized")
        return True
    except Exception as e:
        logger.error(f"❌ Pool init failed: {e}")
        return False

def get_conn(retries=2):
    """Get DB connection with REAL error logging"""
    if not _db_pool:
        logger.error("❌ CRITICAL: DB pool not initialized!")
        return None
        
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        logger.error("❌ CRITICAL: DATABASE_URL env var is MISSING!")
        return None
    
    for i in range(retries + 1):
        try:
            conn = _db_pool.getconn()
            # Test the connection
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.close()
            return conn
        except OperationalError as e:
            # ⚠️ THIS IS THE KEY: Log the REAL error to Render logs
            logger.error(f"❌ DB OperationalError (attempt {i+1}): {str(e)}")
            logger.error(f"   URL preview: {db_url.split('@')[-1].split('/')[0] if '@' in db_url else 'invalid'}")
            if i < retries:
                time.sleep(0.3 * (i + 1))
                continue
            return None
        except Exception as e:
            logger.error(f"❌ DB Unexpected error: {type(e).__name__}: {str(e)}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    return None
def release_conn(conn):
    if conn and _db_pool:
        try: _db_pool.putconn(conn)
        except: 
            try: conn.close()
            except: pass

# ============ HELPERS ============
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization")
        if not token: return jsonify({"msg": "no_token"}), 401
        try:
            token = token.replace("Bearer ", "").strip()
            data = jwt.decode(token, app.secret_key, algorithms=["HS256"])
            g.user_data = data
            g.user_id = data.get("user_id") or data.get("user")
            if not g.user_id: return jsonify({"msg": "invalid_token"}), 401
        except jwt.ExpiredSignatureError: return jsonify({"msg": "token_expired"}), 401
        except jwt.InvalidTokenError: return jsonify({"msg": "invalid_token"}), 401
        except Exception as e:
            logger.error(f"Token error: {e}"); return jsonify({"msg": "server_error"}), 500
        return f(*args, **kwargs)
    return decorated

def resolve_user_id(cur, user_val):
    if isinstance(user_val, int): return user_val
    cur.execute("SELECT id FROM users WHERE username = %s", (str(user_val),))
    row = cur.fetchone()
    return row[0] if row else None

def update_last_seen(user_id):
    try:
        conn = get_conn()
        if not conn: return
        cur = conn.cursor()
        cur.execute("UPDATE users SET last_seen = NOW() WHERE id = %s", (user_id,))
        conn.commit(); cur.close(); release_conn(conn)
    except: pass

def extract_public_id(url):
    if not url or "cloudinary" not in url: return None
    try:
        parts = url.split("/upload/")
        if len(parts) < 2: return None
        path = parts[1]
        if path.startswith("v") and "/" in path: path = path.split("/", 1)[1]
        return path.rsplit(".", 1)[0]
    except: return None

def delete_asset(url, rtype="image"):
    pid = extract_public_id(url)
    if not pid: return False
    try:
        cloudinary.api.delete_resources([pid], resource_type=rtype)
        return True
    except: return False

# ============ ROUTES: Static ============
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
    """Health check that actually verifies DB connection"""
    try:
        # Check env var first
        if not os.environ.get("DATABASE_URL"):
            logger.error("❌ Health check failed: DATABASE_URL not set")
            return jsonify({"status": "unhealthy", "error": "missing_db_url"}), 503
            
        # Try to get a connection
        conn = get_conn()
        if not conn:
            logger.error("❌ Health check failed: get_conn() returned None")
            return jsonify({"status": "unhealthy", "error": "db_connection_failed"}), 503
            
        # Test query
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        release_conn(conn)
        
        return jsonify({"status": "healthy", "ts": datetime.datetime.utcnow().isoformat()})
    except Exception as e:
        logger.error(f"❌ Health check exception: {type(e).__name__}: {str(e)}")
        return jsonify({"status": "unhealthy", "error": str(e)}), 503
@app.route("/api/verify", methods=["GET"])
@token_required
def verify_token():
    username = g.user_data.get("user") or g.user_data.get("user_id")
    return jsonify({"msg": "ok", "username": username})

@app.route("/signup", methods=["POST"])
@limiter.limit("5 per minute")
def signup():
    data = request.json
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower() if data.get("email") else None
    phone = data.get("phone", "").strip() if data.get("phone") else None
    password = data.get("password", "")
    if not email and not phone: return jsonify({"msg": "need_email_or_phone"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        if email:
            cur.execute("SELECT 1 FROM users WHERE email=%s", (email,))
            if cur.fetchone(): return jsonify({"msg": "email_used"}), 409
        if phone:
            cur.execute("SELECT 1 FROM users WHERE phone=%s", (phone,))
            if cur.fetchone(): return jsonify({"msg": "phone_used"}), 409
        
        for _ in range(10):
            username = name.lower().replace(" ", "") + str(random.randint(1000, 9999))
            cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
            if not cur.fetchone(): break
        else: return jsonify({"msg": "username_failed"}), 500
        
        cur.execute("INSERT INTO users (name,email,phone,username,password) VALUES (%s,%s,%s,%s,%s)",
                   (name, email, phone, username, password))
        conn.commit()
        token = jwt.encode({"user": username, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
                          app.secret_key, algorithm="HS256")
        return jsonify({"msg": "created", "username": username, "token": token, "profile_picture": "unknown"})
    except Exception as e:
        conn.rollback(); logger.error(f"Signup: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/login", methods=["POST"])
@limiter.limit("10 per minute")
def login():
    data = request.json
    email = data.get("email", "").strip().lower() if data.get("email") else None
    phone = data.get("phone", "").strip() if data.get("phone") else None
    password = data.get("password", "")
    if not email and not phone: return jsonify({"msg": "email_or_phone_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        cur.execute("SELECT * FROM users WHERE email=%s" if email else "SELECT * FROM users WHERE phone=%s",
                   (email or phone,))
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 401
        if user[5] != password: return jsonify({"msg": "wrong_password"}), 401
        pic = user[6] if len(user) > 6 else "unknown"
        token = jwt.encode({"user_id": user[0], "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
                          app.secret_key, algorithm="HS256")
        return jsonify({"msg": "success", "token": token, "profile_picture": pic})
    finally: cur.close(); release_conn(conn)

@app.route("/google-login", methods=["POST"])
@limiter.limit("10 per minute")
def google_login():
    data = request.json
    email = data.get("email", "").strip().lower()
    name = data.get("name", "").strip()
    picture = data.get("picture") or "unknown"
    if not email or not name: return jsonify({"msg": "email_and_name_required"}), 400
    
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        cur.execute("SELECT id,username,profile_picture FROM users WHERE email=%s", (email,))
        user = cur.fetchone()
        if user:
            username = user[1]
            if picture != "unknown" and picture != user[2]:
                cur.execute("UPDATE users SET profile_picture=%s WHERE email=%s", (picture, email))
                conn.commit()
        else:
            for _ in range(10):
                username = name.lower().replace(" ", "") + str(random.randint(1000, 9999))
                cur.execute("SELECT 1 FROM users WHERE username=%s", (username,))
                if not cur.fetchone(): break
            else: return jsonify({"msg": "username_failed"}), 500
            cur.execute("INSERT INTO users (name,email,username,password,profile_picture) VALUES (%s,%s,%s,%s,%s)",
                       (name, email, username, "google_auth", picture))
            conn.commit()
        token = jwt.encode({"user": username, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
                          app.secret_key, algorithm="HS256")
        return jsonify({"msg": "success", "token": token, "username": username, "profile_picture": picture})
    except Exception as e:
        conn.rollback(); logger.error(f"Google login: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

# ============ ROUTES: Posts ============
@app.route("/add_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_post():
    content = request.form.get("content", "").strip()
    image_url = request.form.get("image_url")
    video_url = request.form.get("video_url")
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("INSERT INTO posts (user_id,content,image,video) VALUES (%s,%s,%s,%s)",
                   (user_id, content, image_url, video_url))
        conn.commit()
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "post_created"})
    except Exception as e:
        conn.rollback(); logger.error(f"Add post: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/get_posts", methods=["GET"])
@cache.cached(timeout=30, query_string=True)
@limiter.limit("60 per minute")
def get_posts():
    page = max(1, request.args.get('page', 1, type=int))
    per_page = min(50, request.args.get('per_page', 20, type=int))
    offset = (page - 1) * per_page
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT p.id,p.content,p.image,p.video,p.like_count,p.comment_count,p.repost_count,u.username,u.profile_picture
            FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT %s OFFSET %s
        """, (per_page, offset))
        return jsonify([{"id":r[0],"content":r[1],"image":r[2],"video":r[3],"likes":r[4],"comments":r[5],
                        "reposts":r[6],"username":r[7],"profile_picture":r[8]} for r in cur.fetchall()])
    finally: cur.close(); release_conn(conn)

@app.route("/like_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def like_post():
    post_id = request.json.get("post_id")
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
        else:
            cur.execute("INSERT INTO likes (user_id,post_id) VALUES (%s,%s)", (user_id, post_id))
            cur.execute("UPDATE posts SET like_count=like_count+1 WHERE id=%s", (post_id,))
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "done"})
    except Exception as e:
        conn.rollback(); logger.error(f"Like: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/repost_post", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def repost_post():
    post_id = request.json.get("post_id")
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
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "done"})
    except Exception as e:
        conn.rollback(); logger.error(f"Repost: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

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
        owner_id, img, vid = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id: return jsonify({"msg": "unauthorized"}), 403
        if img: delete_asset(img, "image")
        if vid: delete_asset(vid, "video")
        cur.execute("DELETE FROM posts WHERE id=%s", (post_id,))
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback(); logger.error(f"Delete post: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/edit_post/<int:post_id>", methods=["PUT"])
@token_required
def edit_post(post_id):
    content = request.form.get("content")
    image = request.files.get("image")
    if not content and not image: return jsonify({"msg": "nothing_to_update"}), 400
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        cur.execute("SELECT user_id,image FROM posts WHERE id=%s", (post_id,))
        row = cur.fetchone()
        if not row: return jsonify({"msg": "not_found"}), 404
        owner_id, old_img = row
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id or user_id != owner_id: return jsonify({"msg": "unauthorized"}), 403
        new_img = old_img
        if image and image.filename:
            res = cloudinary.uploader.upload(image)
            new_img = res["secure_url"]
            if old_img and "unknown" not in old_img: delete_asset(old_img, "image")
        cur.execute("UPDATE posts SET content=%s,image=%s WHERE id=%s", (content, new_img, post_id))
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "updated"})
    except Exception as e:
        conn.rollback(); logger.error(f"Edit post: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

# ============ ROUTES: Comments ============
@app.route("/get_comments/<int:post_id>", methods=["GET"])
@cache.cached(timeout=60, query_string=True)
def get_comments(post_id):
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT c.id,c.content,c.created_at,u.username,u.name,u.profile_picture
            FROM comments c JOIN users u ON c.user_id=u.id WHERE c.post_id=%s ORDER BY c.created_at ASC LIMIT 100
        """, (post_id,))
        return jsonify([{"id":r[0],"content":r[1],"created_at":str(r[2]),"username":r[3],"name":r[4],"profile_picture":r[5]} for r in cur.fetchall()])
    finally: cur.close(); release_conn(conn)

@app.route("/add_comment", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_comment():
    post_id = request.json.get("post_id")
    content = request.json.get("content", "").strip()
    if not post_id or not content: return jsonify({"msg": "missing_fields"}), 400
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("INSERT INTO comments (post_id,user_id,content) VALUES (%s,%s,%s)", (post_id, user_id, content))
        cur.execute("UPDATE posts SET comment_count=comment_count+1 WHERE id=%s", (post_id,))
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "comment_added"})
    except Exception as e:
        conn.rollback(); logger.error(f"Add comment: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

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
        if not user_id or user_id != owner_id: return jsonify({"msg": "unauthorized"}), 403
        cur.execute("DELETE FROM comments WHERE id=%s", (comment_id,))
        cur.execute("UPDATE posts SET comment_count=GREATEST(comment_count-1,0) WHERE id=%s", (post_id,))
        conn.commit(); cache.delete_memoized(get_posts)
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback(); logger.error(f"Delete comment: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

# ============ ROUTES: Follows ============
@app.route("/follow", methods=["POST"])
@token_required
@limiter.limit("20 per minute")
def follow():
    target = request.json.get("username")
    if not target or target == (g.user_data.get("user") or g.user_data.get("user_id")):
        return jsonify({"msg": "invalid_target"}), 400
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        cur.execute("SELECT id FROM users WHERE username=%s", (target,))
        t_row = cur.fetchone()
        if not t_row: return jsonify({"msg": "user_not_found"}), 404
        target_id = t_row[0]
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
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
            return jsonify({"msg": "followed", "status": status})
    except Exception as e:
        conn.rollback(); logger.error(f"Follow: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/get_friends", methods=["GET"])
@token_required
@cache.cached(timeout=30)
def get_friends():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        cur.execute("""
            SELECT u.id,u.username,u.name,u.profile_picture,
                   CASE WHEN u.last_seen > NOW() - INTERVAL '30 seconds' THEN true ELSE false END
            FROM users u WHERE u.id != %s
            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id=%s AND f1.following_id=u.id)
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s)
        """, (user_id, user_id, user_id))
        return jsonify([{"id":r[0],"username":r[1],"name":r[2],"profile_picture":r[3],"is_online":r[4]} for r in cur.fetchall()])
    finally: cur.close(); release_conn(conn)

@app.route("/my_follows", methods=["GET"])
@token_required
@cache.cached(timeout=60)
def get_my_follows():
    conn = get_conn()
    if not conn: return jsonify({"following":[],"friends":[]}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("""SELECT u.username FROM users u JOIN follows f ON f.following_id=u.id
            WHERE f.follower_id=%s AND NOT EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s)""", (user_id, user_id))
        following = [r[0] for r in cur.fetchall()]
        cur.execute("""SELECT u.username FROM users u JOIN follows f ON f.following_id=u.id
            WHERE f.follower_id=%s AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s)""", (user_id, user_id))
        friends = [r[0] for r in cur.fetchall()]
        return jsonify({"following": following, "friends": friends})
    finally: cur.close(); release_conn(conn)

# ============ ROUTES: Profile ============
@app.route("/get_my_info", methods=["GET"])
@token_required
@cache.cached(timeout=120)
def get_my_info():
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        if isinstance(g.user_id, int):
            cur.execute("SELECT username,name,email,phone,profile_picture FROM users WHERE id=%s", (g.user_id,))
        else:
            cur.execute("SELECT username,name,email,phone,profile_picture FROM users WHERE username=%s", (str(g.user_id),))
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 404
        return jsonify({"username":user[0],"name":user[1],"email":user[2],"phone":user[3],"profile_picture":user[4]})
    finally: cur.close(); release_conn(conn)

@app.route("/update_profile", methods=["POST"])
@token_required
@limiter.limit("10 per minute")
def update_profile():
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        if isinstance(g.user_id, int):
            cur.execute("SELECT id,name,email,phone,username,password,profile_picture FROM users WHERE id=%s", (g.user_id,))
        else:
            cur.execute("SELECT id,name,email,phone,username,password,profile_picture FROM users WHERE username=%s", (str(g.user_id),))
        user = cur.fetchone()
        if not user: return jsonify({"msg": "user_not_found"}), 404
        uid, old_name, old_email, old_phone, old_user, old_pass, old_pic = user
        new_name = request.form.get("name", "").strip() or old_name
        new_user = request.form.get("username", "").strip() or old_user
        new_email = request.form.get("email", "").strip() or None
        new_phone = request.form.get("phone", "").strip() or None
        old_pw = request.form.get("old_password", "").strip()
        new_pw = request.form.get("new_password", "").strip()
        if new_user != old_user:
            cur.execute("SELECT 1 FROM users WHERE username=%s", (new_user,))
            if cur.fetchone(): return jsonify({"msg": "username_taken"}), 409
        if new_email and new_email != old_email:
            cur.execute("SELECT 1 FROM users WHERE email=%s", (new_email,))
            if cur.fetchone(): return jsonify({"msg": "email_used"}), 409
        if new_phone and new_phone != old_phone:
            cur.execute("SELECT 1 FROM users WHERE phone=%s", (new_phone,))
            if cur.fetchone(): return jsonify({"msg": "phone_used"}), 409
        new_pic = old_pic
        img = request.files.get("profile_image")
        if img and img.filename:
            res = cloudinary.uploader.upload(img)
            new_pic = res["secure_url"]
            if old_pic and "unknown" not in old_pic: delete_asset(old_pic, "image")
        updates, params = [], []
        if new_name != old_name: updates.append("name=%s"); params.append(new_name)
        if new_user != old_user: updates.append("username=%s"); params.append(new_user)
        if new_email != old_email: updates.append("email=%s"); params.append(new_email)
        if new_phone != old_phone: updates.append("phone=%s"); params.append(new_phone)
        if new_pic != old_pic: updates.append("profile_picture=%s"); params.append(new_pic)
        if new_pw:
            if not old_pw or (old_pass != old_pw and "google_auth" not in old_pass):
                return jsonify({"msg": "old_password_incorrect"}), 400
            if len(new_pw) < 6: return jsonify({"msg": "password_too_short"}), 400
            updates.append("password=%s"); params.append(new_pw)
        if updates:
            params.append(uid)
            cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=%s", params)
            conn.commit()
        return jsonify({"msg": "updated", "username": new_user, "profile_picture": new_pic, "name": new_name})
    except Exception as e:
        conn.rollback(); logger.error(f"Update profile: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/user/<username>", methods=["GET"])
@cache.cached(timeout=60, query_string=True)
def get_user_profile(username):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        cur.execute("SELECT id,username,name,profile_picture FROM users WHERE username=%s", (username,))
        user = cur.fetchone()
        if not user: return jsonify({"msg": "not_found"}), 404
        cur.execute("SELECT COUNT(*) FROM follows WHERE following_id=%s", (user[0],)); followers = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM follows WHERE follower_id=%s", (user[0],)); following = cur.fetchone()[0]
        cur.execute("""
            SELECT p.id,p.content,p.image,p.video,p.like_count,p.comment_count,p.repost_count,p.created_at,u.username,u.profile_picture
            FROM posts p JOIN users u ON p.user_id=u.id WHERE p.user_id=%s ORDER BY p.created_at DESC LIMIT 50
        """, (user[0],))
        posts = [{"id":p[0],"content":p[1],"image":p[2],"video":p[3],"likes":p[4],"comments":p[5],
                 "reposts":p[6],"created_at":str(p[7]),"username":p[8],"profile_picture":p[9]} for p in cur.fetchall()]
        return jsonify({"id":user[0],"username":user[1],"name":user[2],"profile_picture":user[3],
                       "followers":followers,"following":following,"posts":posts})
    finally: cur.close(); release_conn(conn)

# ============ ROUTES: Messages ============
@app.route("/search_users", methods=["GET"])
@token_required
@cache.cached(timeout=300, query_string=True)
def search_users():
    query = request.args.get("q", "").strip().lower()
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        if query:
            cur.execute("SELECT username,name,profile_picture FROM users WHERE username LIKE %s OR name ILIKE %s ORDER BY username LIMIT 20", (f"%{query}%", f"%{query}%"))
        else:
            cur.execute("SELECT username,name,profile_picture FROM users ORDER BY username LIMIT 20")
        return jsonify([{"username":r[0],"name":r[1],"profile_picture":r[2]} for r in cur.fetchall()])
    finally: cur.close(); release_conn(conn)

@app.route("/get_friends_list", methods=["GET"])
@token_required
@cache.cached(timeout=30)
def get_friends_list():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        cur.execute("""
            SELECT u.id,u.username,u.name,u.profile_picture,
                   CASE WHEN u.last_seen > NOW() - INTERVAL '60 seconds' THEN true ELSE false END
            FROM users u WHERE u.id != %s
            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id=%s AND f1.following_id=u.id)
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id=u.id AND f2.following_id=%s)
            ORDER BY u.last_seen DESC
        """, (user_id, user_id, user_id))
        return jsonify([{"id":r[0],"username":r[1],"name":r[2],"profile_picture":r[3],"is_online":r[4]} for r in cur.fetchall()])
    finally: cur.close(); release_conn(conn)

@app.route("/get_conversations", methods=["GET"])
@token_required
@cache.cached(timeout=20)
def get_conversations():
    conn = get_conn()
    if not conn: return jsonify([]), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        update_last_seen(user_id)
        cur.execute("""
            SELECT CASE WHEN m.sender_id=%s THEN m.receiver_id ELSE m.sender_id END,
                   MAX(m.created_at), COUNT(CASE WHEN m.receiver_id=%s AND m.is_read=FALSE THEN 1 END)
            FROM messages m WHERE m.sender_id=%s OR m.receiver_id=%s GROUP BY 1 ORDER BY 2 DESC LIMIT 50
        """, (user_id, user_id, user_id, user_id))
        convs = []
        for row in cur.fetchall():
            other_id, last_time, unread = row
            cur.execute("SELECT username,name,profile_picture FROM users WHERE id=%s", (other_id,))
            u = cur.fetchone()
            cur.execute("""SELECT content,sender_id FROM messages
                WHERE (sender_id=%s AND receiver_id=%s) OR (sender_id=%s AND receiver_id=%s) ORDER BY created_at DESC LIMIT 1""",
                (user_id, other_id, other_id, user_id))
            lm = cur.fetchone()
            if u: convs.append({"user_id":other_id,"username":u[0],"name":u[1],"profile_picture":u[2],
                               "last_message_time":str(last_time),"last_message":lm[0] if lm else "",
                               "last_message_from_me":lm[1]==user_id if lm else False,"unread_count":unread})
        return jsonify(convs)
    finally: cur.close(); release_conn(conn)

@app.route("/get_messages/<string:other_username>", methods=["GET"])
@token_required
@cache.cached(timeout=10, query_string=True)
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
        cur.execute("UPDATE messages SET is_read=TRUE WHERE sender_id=%s AND receiver_id=%s AND is_read=FALSE", (other_id, user_id))
        conn.commit()
        cur.execute("""
            SELECT m.id,m.content,m.created_at,m.sender_id,m.reply_to_id,u.username,u.profile_picture,
                   r.id,r.content,r.sender_id,ru.username
            FROM messages m JOIN users u ON m.sender_id=u.id
            LEFT JOIN messages r ON m.reply_to_id=r.id LEFT JOIN users ru ON r.sender_id=ru.id
            WHERE (m.sender_id=%s AND m.receiver_id=%s) OR (m.sender_id=%s AND m.receiver_id=%s)
            ORDER BY m.created_at ASC LIMIT 100
        """, (user_id, other_id, other_id, user_id))
        msgs = []
        for row in cur.fetchall():
            mid = row[0]
            cur.execute("SELECT emoji,user_id FROM message_reactions WHERE message_id=%s", (mid,))
            reactions = cur.fetchall()
            counts = {}; [counts.__setitem__(e, counts.get(e,0)+1) for e,_ in reactions]
            user_reacts = [e for e,uid in reactions if uid==user_id]
            msgs.append({"id":mid,"content":row[1],"created_at":str(row[2]),"sender_id":row[3],"reply_to_id":row[4],
                        "sender_username":row[5],"sender_picture":row[6],"is_mine":row[3]==user_id,
                        "reply_context":{"id":row[7],"content":row[8],"sender_id":row[9],"sender_username":row[10]} if row[7] else None,
                        "reactions":counts,"user_reactions":user_reacts})
        return jsonify({"messages":msgs,"other_user_picture":other_pic})
    except Exception as e:
        conn.rollback(); logger.error(f"Get messages: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/send_message", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def send_message():
    receiver = request.json.get("receiver_username")
    content = request.json.get("content", "").strip()
    if not receiver or not content: return jsonify({"msg": "missing_fields"}), 400
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
        reply_to = request.json.get("reply_to_id")
        cur.execute("INSERT INTO messages (sender_id,receiver_id,content,reply_to_id) VALUES (%s,%s,%s,%s)",
                   (sender_id, receiver_id, content, reply_to))
        conn.commit()
        cache.delete_memoized(get_conversations)
        cache.delete_memoized(get_messages, other_username=receiver)
        return jsonify({"msg": "sent"})
    except Exception as e:
        conn.rollback(); logger.error(f"Send message: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/delete_message/<int:message_id>", methods=["DELETE"])
@token_required
def delete_message(message_id):
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        sender_id = resolve_user_id(cur, g.user_id)
        if not sender_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("SELECT sender_id FROM messages WHERE id=%s", (message_id,))
        row = cur.fetchone()
        if not row or row[0] != sender_id: return jsonify({"msg": "unauthorized"}), 403
        cur.execute("DELETE FROM messages WHERE id=%s", (message_id,))
        conn.commit()
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback(); logger.error(f"Delete message: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/add_reaction", methods=["POST"])
@token_required
@limiter.limit("30 per minute")
def add_reaction():
    message_id = request.json.get("message_id")
    emoji = request.json.get("emoji")
    if not message_id or not emoji: return jsonify({"msg": "missing_fields"}), 400
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("SELECT sender_id FROM messages WHERE id=%s", (message_id,))
        row = cur.fetchone()
        if row and row[0] == user_id: return jsonify({"msg": "cannot_react_own"}), 400
        cur.execute("INSERT INTO message_reactions (message_id,user_id,emoji) VALUES (%s,%s,%s)",
                   (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_added"})
    except Exception as e:
        conn.rollback()
        if "unique" in str(e).lower(): return jsonify({"msg": "already_reacted"}), 409
        logger.error(f"Add reaction: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

@app.route("/remove_reaction", methods=["POST"])
@token_required
def remove_reaction():
    message_id = request.json.get("message_id")
    emoji = request.json.get("emoji")
    if not message_id or not emoji: return jsonify({"msg": "missing_fields"}), 400
    conn = get_conn()
    if not conn: return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    try:
        user_id = resolve_user_id(cur, g.user_id)
        if not user_id: return jsonify({"msg": "user_not_found"}), 404
        cur.execute("DELETE FROM message_reactions WHERE message_id=%s AND user_id=%s AND emoji=%s",
                   (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_removed"})
    except Exception as e:
        conn.rollback(); logger.error(f"Remove reaction: {e}")
        return jsonify({"msg": "error"}), 500
    finally: cur.close(); release_conn(conn)

# ============ DB INIT ============
def init_db():
    conn = get_conn()
    if not conn: return False
    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY,name TEXT,email TEXT UNIQUE,phone TEXT UNIQUE,
                username TEXT UNIQUE,password TEXT,profile_picture TEXT DEFAULT 'unknown',last_seen TIMESTAMP DEFAULT NOW());
            CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,image TEXT,video TEXT,created_at TIMESTAMP DEFAULT NOW(),like_count INT DEFAULT 0,
                comment_count INT DEFAULT 0,repost_count INT DEFAULT 0);
            CREATE TABLE IF NOT EXISTS likes (id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(user_id,post_id));
            CREATE TABLE IF NOT EXISTS follows (id SERIAL PRIMARY KEY,follower_id INT REFERENCES users(id) ON DELETE CASCADE,
                following_id INT REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(follower_id,following_id));
            CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY,post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,content TEXT,created_at TIMESTAMP DEFAULT NOW());
            CREATE TABLE IF NOT EXISTS reposts (id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(user_id,post_id));
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY,sender_id INT REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INT REFERENCES users(id) ON DELETE CASCADE,content TEXT,created_at TIMESTAMP DEFAULT NOW(),
                is_read BOOLEAN DEFAULT FALSE,reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL);
            CREATE TABLE IF NOT EXISTS message_reactions (id SERIAL PRIMARY KEY,message_id INT REFERENCES messages(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,emoji TEXT,created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id,user_id,emoji));
            -- Indexes for speed
            CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_msgs_users ON messages(sender_id,receiver_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_follows ON follows(follower_id,following_id);
            CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
            CREATE INDEX IF NOT EXISTS idx_reposts_post ON reposts(post_id);
            CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id,created_at);
            CREATE INDEX IF NOT EXISTS idx_users_lookup ON users(username,email);
        """)
        conn.commit()
        logger.info("✅ Tables ready")
        return True
    except Exception as e:
        conn.rollback(); logger.error(f"DB init: {e}"); return False
    finally: cur.close(); release_conn(conn)

# ============ STARTUP ============
def on_starting(server):
    init_db_pool()
    init_db()

def when_ready(server):
    logger.info("🚀 App ready - optimized for concurrency")

# Gunicorn hooks
on_starting = on_starting
when_ready = when_ready
init_db_pool()
init_db()
if __name__ == "__main__":
   
    # Local dev only - use Gunicorn in production
    app.run(debug=False, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
