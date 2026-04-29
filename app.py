import os
import logging
import jwt
import datetime
import random
import traceback
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_caching import Cache
from flask_compress import Compress
from psycopg2 import pool
import cloudinary.uploader
import cloudinary.api
import psycopg2

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize app
app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = "secret123"
CORS(app)

Compress(app)

# Cache config
app.config['CACHE_TYPE'] = 'SimpleCache'
app.config['CACHE_DEFAULT_TIMEOUT'] = 300
Cache(app)
cache = Cache(app)
# Cloudinary config
cloudinary.config(
    cloud_name=os.environ.get("CLOUDINARY_CLOUD_NAME", "dlimysibj"),
    api_key=os.environ.get("CLOUDINARY_API_KEY", "239576522747935"),
    api_secret=os.environ.get("CLOUDINARY_API_SECRET", "sn4KlQ9Q-KwEqjOUxvF-MmO2ln8")
)

# Database connection pool
db_pool = None

def init_db_pool():
    global db_pool
    try:
        db_pool = pool.SimpleConnectionPool(
            minconn=1,
            maxconn=4,  # Conservative for free tier
            user=os.environ.get("DB_USER", "neondb_owner"),
            password=os.environ.get("DB_PASSWORD", "npg_UATC3pfibMd6"),
            host=os.environ.get("DB_HOST", "ep-cold-cake-abnyap5j.eu-west-2.aws.neon.tech"),
            port=5432,
            database=os.environ.get("DB_NAME", "neondb"),
            sslmode="require"
        )
        logger.info("✅ Database pool initialized")
    except Exception as e:
        logger.error(f"❌ DB pool init failed: {e}")

def get_conn():
    return db_pool.getconn() if db_pool else None

def release_conn(conn):
    if conn and db_pool:
        db_pool.putconn(conn)

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization")
        if not token:
            return jsonify({"msg": "no_token"}), 401
        try:
            token = token.replace("Bearer ", "").strip()
            data = jwt.decode(token, app.secret_key, algorithms=["HS256"])
            request.current_user = data
            request.current_user_id = data.get("user_id") or data.get("user")
        except Exception:
            return jsonify({"msg": "invalid_token"}), 401
        return f(*args, **kwargs)
    return decorated

# Helper: Update last_seen
def update_last_seen(user_id):
    try:
        conn = get_conn()
        if not conn: return
        cur = conn.cursor()
        cur.execute("UPDATE users SET last_seen = NOW() WHERE id = %s", (user_id,))
        conn.commit()
        cur.close()
        release_conn(conn)
    except Exception as e:
        logger.error(f"Update last_seen error: {e}")

# Helper: Extract Cloudinary public_id
def extract_cloudinary_public_id(url):
    if not url or "cloudinary" not in url:
        return None
    try:
        parts = url.split("/upload/")
        if len(parts) < 2:
            return None
        path = parts[1]
        if path.startswith("v") and "/" in path:
            path = path.split("/", 1)[1]
        return path.rsplit(".", 1)[0]
    except Exception:
        return None

# Helper: Delete from Cloudinary
def delete_cloudinary_asset(url, resource_type="image"):
    public_id = extract_cloudinary_public_id(url)
    if not public_id:
        return False
    try:
        cloudinary.api.delete_resources([public_id], resource_type=resource_type)
        logger.info(f"🗑️ Deleted from Cloudinary: {public_id}")
        return True
    except Exception as e:
        logger.warning(f"⚠️ Cloudinary deletion failed: {e}")
        return False

# Helper: Resolve user_id from username or int
def resolve_user_id(cur, user_val):
    if isinstance(user_val, int):
        return user_val
    cur.execute("SELECT id FROM users WHERE username = %s", (str(user_val),))
    row = cur.fetchone()
    return row[0] if row else None

# ==================== ROUTES ====================

@app.route("/")
def root():
    return send_from_directory("static", "root.html")

@app.route("/home.html")
def serve_home():
    return send_from_directory("static", "home.html")

@app.route("/login.html")
def serve_login():
    return send_from_directory("static", "login.html")

@app.route("/sign_up.html")
def serve_signup():
    return send_from_directory("static", "sign_up.html")

@app.route("/messages.html")
def serve_messages():
    return send_from_directory("static", "messages.html")

@app.route("/health")
def health():
    try:
        conn = get_conn()
        if not conn:
            return jsonify({"status": "unhealthy", "error": "No DB connection"}), 503
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.close()
        release_conn(conn)
        return jsonify({"status": "healthy", "timestamp": datetime.datetime.utcnow().isoformat()}), 200
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({"status": "unhealthy", "error": str(e)}), 503

@app.route("/api/verify", methods=["GET"])
@token_required
def verify_token():
    username = request.current_user.get("user") or request.current_user.get("user_id")
    return jsonify({"msg": "ok", "username": username})

@app.route("/signup", methods=["POST"])
def signup():
    data = request.json
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower() if data.get("email") else None
    phone = data.get("phone", "").strip() if data.get("phone") else None
    password = data.get("password", "")
    
    if not email and not phone:
        return jsonify({"msg": "need_email_or_phone"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        if email:
            cursor.execute("SELECT id FROM users WHERE email=%s", (email,))
            if cursor.fetchone():
                return jsonify({"msg": "email_used"}), 409
        if phone:
            cursor.execute("SELECT id FROM users WHERE phone=%s", (phone,))
            if cursor.fetchone():
                return jsonify({"msg": "phone_used"}), 409
        
        # Generate unique username
        for _ in range(10):
            username = name.lower().replace(" ", "") + str(random.randint(1000, 9999))
            cursor.execute("SELECT id FROM users WHERE username=%s", (username,))
            if not cursor.fetchone():
                break
        else:
            return jsonify({"msg": "username_generation_failed"}), 500
        
        cursor.execute(
            "INSERT INTO users (name, email, phone, username, password, profile_picture) VALUES (%s, %s, %s, %s, %s, %s)",
            (name, email, phone, username, password, "unknown")
        )
        conn.commit()
        
        token = jwt.encode(
            {"user": username, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        return jsonify({"msg": "created", "username": username, "token": token, "profile_picture": "unknown"})
    
    except Exception as e:
        conn.rollback()
        logger.error(f"Signup error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/login", methods=["POST"])
def login():
    data = request.json
    email = data.get("email", "").strip().lower() if data.get("email") else None
    phone = data.get("phone", "").strip() if data.get("phone") else None
    password = data.get("password", "")
    
    if not email and not phone:
        return jsonify({"msg": "email_or_phone_required"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        user = None
        if email:
            cursor.execute("SELECT * FROM users WHERE email=%s", (email,))
            user = cursor.fetchone()
        elif phone:
            cursor.execute("SELECT * FROM users WHERE phone=%s", (phone,))
            user = cursor.fetchone()
        
        if not user:
            return jsonify({"msg": "we dont have that email" if email else "we dont have that number"}), 401
        if user[5] != password:  # password is at index 5
            return jsonify({"msg": "the password is wrong"}), 401
        
        profile_pic = user[6] if len(user) > 6 else "unknown"
        token = jwt.encode(
            {"user_id": user[0], "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        return jsonify({"msg": "success", "token": token, "profile_picture": profile_pic})
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/google-login", methods=["POST"])
def google_login():
    data = request.json
    email = data.get("email", "").strip().lower()
    name = data.get("name", "").strip()
    picture = data.get("picture") or "unknown"
    
    if not email or not name:
        return jsonify({"msg": "email_and_name_required"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT id, username, profile_picture FROM users WHERE email=%s", (email,))
        user = cursor.fetchone()
        
        if user:
            username = user[1]
            if picture != "unknown" and picture != user[2]:
                cursor.execute("UPDATE users SET profile_picture=%s WHERE email=%s", (picture, email))
                conn.commit()
        else:
            for _ in range(10):
                username = name.lower().replace(" ", "") + str(random.randint(1000, 9999))
                cursor.execute("SELECT id FROM users WHERE username=%s", (username,))
                if not cursor.fetchone():
                    break
            else:
                return jsonify({"msg": "username_generation_failed"}), 500
            
            cursor.execute(
                "INSERT INTO users (name, email, phone, username, password, profile_picture) VALUES (%s, %s, NULL, %s, %s, %s)",
                (name, email, username, "google_auth", picture)
            )
            conn.commit()
        
        token = jwt.encode(
            {"user": username, "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)},
            app.secret_key, algorithm="HS256"
        )
        return jsonify({"msg": "success", "token": token, "username": username, "profile_picture": picture})
    
    except Exception as e:
        conn.rollback()
        logger.error(f"Google login error: {e}")
        return jsonify({"msg": "server_error"}), 500
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/add_post", methods=["POST"])
@token_required
def add_post():
    user_val = request.current_user_id
    if not user_val:
        return jsonify({"msg": "no_user_identifier"}), 401
    
    content = request.form.get("content", "").strip()
    image_url = request.form.get("image_url")
    video_url = request.form.get("video_url")
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        user_id = resolve_user_id(cursor, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cursor.execute(
            "INSERT INTO posts (user_id, content, image, video) VALUES (%s, %s, %s, %s)",
            (user_id, content, image_url, video_url)
        )
        conn.commit()
        # Invalidate posts cache
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "post_created"})
    
    except Exception as e:
        conn.rollback()
        logger.error(f"Add post error: {e}")
        return jsonify({"msg": "db_error"}), 500
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/get_posts", methods=["GET"])
@cache.cached(timeout=60, query_string=True)
def get_posts():
    page = request.args.get('page', 1, type=int)
    per_page = min(request.args.get('per_page', 20, type=int), 50)
    offset = (page - 1) * per_page
    
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cursor = conn.cursor()
    
    try:
        cursor.execute("""
            SELECT posts.id, posts.content, posts.image, posts.video,
                   posts.like_count, posts.comment_count, posts.repost_count, 
                   users.username, users.profile_picture
            FROM posts
            JOIN users ON users.id = posts.user_id
            ORDER BY posts.created_at DESC
            LIMIT %s OFFSET %s
        """, (per_page, offset))
        
        posts = []
        for r in cursor.fetchall():
            posts.append({
                "id": r[0], "content": r[1], "image": r[2], "video": r[3],
                "likes": r[4], "comments": r[5], "reposts": r[6],
                "username": r[7], "profile_picture": r[8]
            })
        return jsonify(posts)
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/like_post", methods=["POST"])
@token_required
def like_post():
    user_val = request.current_user_id
    post_id = request.json.get("post_id")
    
    if not post_id:
        return jsonify({"msg": "post_id_required"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        user_id = resolve_user_id(cursor, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cursor.execute("SELECT id FROM likes WHERE user_id=%s AND post_id=%s", (user_id, post_id))
        if cursor.fetchone():
            cursor.execute("DELETE FROM likes WHERE user_id=%s AND post_id=%s", (user_id, post_id))
            cursor.execute("UPDATE posts SET like_count = like_count - 1 WHERE id=%s", (post_id,))
            conn.commit()
            cache.delete_memoized(get_posts)
            return jsonify({"msg": "unliked"})
        else:
            cursor.execute("INSERT INTO likes (user_id, post_id) VALUES (%s, %s)", (user_id, post_id))
            cursor.execute("UPDATE posts SET like_count = like_count + 1 WHERE id=%s", (post_id,))
            conn.commit()
            cache.delete_memoized(get_posts)
            return jsonify({"msg": "liked"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Like error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/follow", methods=["POST"])
@token_required
def follow():
    user_val = request.current_user_id
    target = request.json.get("username")
    
    if not target or target == (request.current_user.get("user") or request.current_user.get("user_id")):
        return jsonify({"msg": "invalid_target"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id FROM users WHERE username = %s", (target,))
        t_row = cur.fetchone()
        if not t_row:
            return jsonify({"msg": "user_not_found"}), 404
        target_id = t_row[0]
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        update_last_seen(user_id)
        
        cur.execute("SELECT id FROM follows WHERE follower_id=%s AND following_id=%s", (user_id, target_id))
        already = cur.fetchone()
        
        if already:
            cur.execute("DELETE FROM follows WHERE follower_id=%s AND following_id=%s", (user_id, target_id))
            conn.commit()
            cur.execute("SELECT id FROM follows WHERE follower_id=%s AND following_id=%s", (target_id, user_id))
            status = "friends" if cur.fetchone() else "none"
            return jsonify({"msg": "unfollowed", "status": status})
        else:
            cur.execute("INSERT INTO follows (follower_id, following_id) VALUES (%s, %s)", (user_id, target_id))
            conn.commit()
            cur.execute("SELECT id FROM follows WHERE follower_id=%s AND following_id=%s", (target_id, user_id))
            status = "friends" if cur.fetchone() else "following"
            return jsonify({"msg": "followed", "status": status})
    except Exception as e:
        conn.rollback()
        logger.error(f"Follow error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_friends", methods=["GET"])
@token_required
def get_friends():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        update_last_seen(user_id)
        
        cur.execute("""
            SELECT u.id, u.username, u.name, u.profile_picture,
                   CASE WHEN u.last_seen > NOW() - INTERVAL '30 seconds' THEN true ELSE false END as is_online
            FROM users u
            WHERE u.id != %s
            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = %s AND f1.following_id = u.id)
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = u.id AND f2.following_id = %s)
        """, (user_id, user_id, user_id))
        
        return jsonify([{"id": r[0], "username": r[1], "name": r[2], "profile_picture": r[3], "is_online": r[4]} for r in cur.fetchall()])
    finally:
        cur.close()
        release_conn(conn)

@app.route("/my_follows", methods=["GET"])
@token_required
def get_my_follows():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"following": [], "friends": []}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("""
            SELECT u.username FROM users u
            JOIN follows f ON f.following_id = u.id
            WHERE f.follower_id = %s
            AND NOT EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = u.id AND f2.following_id = %s)
        """, (user_id, user_id))
        following = [r[0] for r in cur.fetchall()]
        
        cur.execute("""
            SELECT u.username FROM users u
            JOIN follows f ON f.following_id = u.id
            WHERE f.follower_id = %s
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = u.id AND f2.following_id = %s)
        """, (user_id, user_id))
        friends = [r[0] for r in cur.fetchall()]
        
        return jsonify({"following": following, "friends": friends})
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_comments/<int:post_id>", methods=["GET"])
def get_comments(post_id):
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cur = conn.cursor()
    try:
        cur.execute("""
            SELECT c.id, c.content, c.created_at, u.username, u.name, u.profile_picture
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.post_id = %s
            ORDER BY c.created_at ASC
        """, (post_id,))
        return jsonify([{"id": r[0], "content": r[1], "created_at": str(r[2]), "username": r[3], "name": r[4], "profile_picture": r[5]} for r in cur.fetchall()])
    finally:
        cur.close()
        release_conn(conn)

@app.route("/add_comment", methods=["POST"])
@token_required
def add_comment():
    user_val = request.current_user_id
    post_id = request.json.get("post_id")
    content = request.json.get("content", "").strip()
    
    if not post_id or not content:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("INSERT INTO comments (post_id, user_id, content) VALUES (%s, %s, %s)", (post_id, user_id, content))
        cur.execute("UPDATE posts SET comment_count = comment_count + 1 WHERE id = %s", (post_id,))
        conn.commit()
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "comment_added"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Add comment error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/delete_post/<int:post_id>", methods=["DELETE"])
@token_required
def delete_post(post_id):
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT user_id, image, video FROM posts WHERE id = %s", (post_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "post_not_found"}), 404
        post_owner_id, image_url, video_url = row
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id or user_id != post_owner_id:
            return jsonify({"msg": "unauthorized"}), 403
        
        if image_url:
            delete_cloudinary_asset(image_url, "image")
        if video_url:
            delete_cloudinary_asset(video_url, "video")
        
        cur.execute("DELETE FROM posts WHERE id = %s", (post_id,))
        conn.commit()
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Delete post error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/edit_post/<int:post_id>", methods=["PUT"])
@token_required
def edit_post(post_id):
    user_val = request.current_user_id
    content = request.form.get("content")
    image = request.files.get("image")
    
    if not content and not image:
        return jsonify({"msg": "nothing_to_update"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT user_id, image FROM posts WHERE id = %s", (post_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "post_not_found"}), 404
        post_owner, old_image = row
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id or user_id != post_owner:
            return jsonify({"msg": "unauthorized"}), 403
        
        new_image_url = old_image
        if image and image.filename:
            upload_result = cloudinary.uploader.upload(image)
            new_image_url = upload_result["secure_url"]
            if old_image and "unknown" not in old_image:
                delete_cloudinary_asset(old_image, "image")
        
        cur.execute("UPDATE posts SET content = %s, image = %s WHERE id = %s", (content, new_image_url, post_id))
        conn.commit()
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "updated"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Edit post error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_my_info", methods=["GET"])
@token_required
def get_my_info():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        if isinstance(user_val, int):
            cur.execute("SELECT username, name, email, phone, profile_picture FROM users WHERE id = %s", (user_val,))
        else:
            cur.execute("SELECT username, name, email, phone, profile_picture FROM users WHERE username = %s", (str(user_val),))
        user = cur.fetchone()
        if not user:
            return jsonify({"msg": "not_found"}), 404
        return jsonify({"username": user[0], "name": user[1], "email": user[2], "phone": user[3], "profile_picture": user[4]})
    finally:
        cur.close()
        release_conn(conn)

@app.route("/update_profile", methods=["POST"])
@token_required
def update_profile():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        if isinstance(user_val, int):
            cur.execute("SELECT id, name, email, phone, username, password, profile_picture FROM users WHERE id = %s", (user_val,))
        else:
            cur.execute("SELECT id, name, email, phone, username, password, profile_picture FROM users WHERE username = %s", (str(user_val),))
        user = cur.fetchone()
        if not user:
            return jsonify({"msg": "user_not_found"}), 404
        
        user_id, old_name, old_email, old_phone, old_username, old_pass, old_pic = user
        
        new_name = request.form.get("name", "").strip() or old_name
        new_username = request.form.get("username", "").strip() or old_username
        new_email = request.form.get("email", "").strip() or None
        new_phone = request.form.get("phone", "").strip() or None
        old_password = request.form.get("old_password", "").strip()
        new_password = request.form.get("new_password", "").strip()
        
        if new_username != old_username:
            cur.execute("SELECT id FROM users WHERE username = %s", (new_username,))
            if cur.fetchone():
                return jsonify({"msg": "username_taken"}), 409
        if new_email and new_email != old_email:
            cur.execute("SELECT id FROM users WHERE email = %s", (new_email,))
            if cur.fetchone():
                return jsonify({"msg": "email_used"}), 409
        if new_phone and new_phone != old_phone:
            cur.execute("SELECT id FROM users WHERE phone = %s", (new_phone,))
            if cur.fetchone():
                return jsonify({"msg": "phone_used"}), 409
        
        new_pic = old_pic
        img = request.files.get("profile_image")
        if img and img.filename:
            res = cloudinary.uploader.upload(img)
            new_pic = res["secure_url"]
            if old_pic and "unknown" not in old_pic:
                delete_cloudinary_asset(old_pic, "image")
        
        updates, params = [], []
        if new_name != old_name: updates.append("name = %s"); params.append(new_name)
        if new_username != old_username: updates.append("username = %s"); params.append(new_username)
        if new_email != old_email: updates.append("email = %s"); params.append(new_email)
        if new_phone != old_phone: updates.append("phone = %s"); params.append(new_phone)
        if new_pic != old_pic: updates.append("profile_picture = %s"); params.append(new_pic)
        
        if new_password:
            if not old_password or (old_pass != old_password and "google_auth" not in old_pass):
                return jsonify({"msg": "old_password_incorrect"}), 400
            if len(new_password) < 6:
                return jsonify({"msg": "password_too_short"}), 400
            updates.append("password = %s"); params.append(new_password)
        
        if updates:
            params.append(user_id)
            query = f"UPDATE users SET {', '.join(updates)} WHERE id = %s"
            cur.execute(query, params)
            conn.commit()
        
        return jsonify({"msg": "updated", "username": new_username, "profile_picture": new_pic, "name": new_name})
    except Exception as e:
        conn.rollback()
        logger.error(f"Update profile error: {e}")
        return jsonify({"msg": "server_error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/user/<username>", methods=["GET"])
def get_user_profile(username):
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id, username, name, profile_picture FROM users WHERE username = %s", (username,))
        user = cur.fetchone()
        if not user:
            return jsonify({"msg": "not_found"}), 404
        
        cur.execute("SELECT COUNT(*) FROM follows WHERE following_id = %s", (user[0],))
        followers = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM follows WHERE follower_id = %s", (user[0],))
        following = cur.fetchone()[0]
        
        cur.execute("""
            SELECT p.id, p.content, p.image, p.video, p.like_count, p.comment_count, p.repost_count, p.created_at, u.username, u.profile_picture
            FROM posts p
            JOIN users u ON p.user_id = u.id
            WHERE p.user_id = %s
            ORDER BY p.created_at DESC
            LIMIT 50
        """, (user[0],))
        posts = cur.fetchall()
        
        return jsonify({
            "id": user[0], "username": user[1], "name": user[2], "profile_picture": user[3],
            "followers": followers, "following": following,
            "posts": [{"id": p[0], "content": p[1], "image": p[2], "video": p[3],
                      "likes": p[4], "comments": p[5], "reposts": p[6],
                      "created_at": str(p[7]), "username": p[8], "profile_picture": p[9]} for p in posts]
        })
    finally:
        cur.close()
        release_conn(conn)

@app.route("/repost_post", methods=["POST"])
@token_required
def repost_post():
    user_val = request.current_user_id
    post_id = request.json.get("post_id")
    if not post_id:
        return jsonify({"msg": "post_id_required"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cursor = conn.cursor()
    
    try:
        user_id = resolve_user_id(cursor, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cursor.execute("SELECT id FROM reposts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
        if cursor.fetchone():
            cursor.execute("DELETE FROM reposts WHERE user_id=%s AND post_id=%s", (user_id, post_id))
            cursor.execute("UPDATE posts SET repost_count = repost_count - 1 WHERE id=%s", (post_id,))
            conn.commit()
            cache.delete_memoized(get_posts)
            return jsonify({"msg": "unreposted"})
        else:
            cursor.execute("INSERT INTO reposts (user_id, post_id) VALUES (%s, %s)", (user_id, post_id))
            cursor.execute("UPDATE posts SET repost_count = repost_count + 1 WHERE id=%s", (post_id,))
            conn.commit()
            cache.delete_memoized(get_posts)
            return jsonify({"msg": "reposted"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Repost error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cursor.close()
        release_conn(conn)

@app.route("/edit_comment/<int:comment_id>", methods=["PUT"])
@token_required
def edit_comment(comment_id):
    user_val = request.current_user_id
    content = request.json.get("content", "").strip()
    if not content:
        return jsonify({"msg": "empty_content"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT post_id, user_id FROM comments WHERE id = %s", (comment_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "comment_not_found"}), 404
        post_id, comment_owner = row
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id or user_id != comment_owner:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("UPDATE comments SET content = %s WHERE id = %s", (content, comment_id))
        conn.commit()
        return jsonify({"msg": "updated", "content": content})
    except Exception as e:
        conn.rollback()
        logger.error(f"Edit comment error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/delete_comment/<int:comment_id>", methods=["DELETE"])
@token_required
def delete_comment(comment_id):
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT post_id, user_id FROM comments WHERE id = %s", (comment_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "comment_not_found"}), 404
        post_id, comment_owner = row
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id or user_id != comment_owner:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("DELETE FROM comments WHERE id = %s", (comment_id,))
        cur.execute("UPDATE posts SET comment_count = comment_count - 1 WHERE id = %s", (post_id,))
        conn.commit()
        cache.delete_memoized(get_posts)
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Delete comment error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/search_users", methods=["GET"])
@token_required
def search_users():
    query = request.args.get("q", "").strip().lower()
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        if query:
            cur.execute("SELECT username, name, profile_picture FROM users WHERE username LIKE %s OR name ILIKE %s ORDER BY username LIMIT 20", (f"%{query}%", f"%{query}%"))
        else:
            cur.execute("SELECT username, name, profile_picture FROM users ORDER BY username LIMIT 20")
        return jsonify([{"username": r[0], "name": r[1], "profile_picture": r[2]} for r in cur.fetchall()])
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_friends_list", methods=["GET"])
@token_required
def get_friends_list():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        update_last_seen(user_id)
        
        cur.execute("""
            SELECT u.id, u.username, u.name, u.profile_picture,
                   CASE WHEN u.last_seen > NOW() - INTERVAL '60 seconds' THEN true ELSE false END as is_online
            FROM users u
            WHERE u.id != %s
            AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = %s AND f1.following_id = u.id)
            AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = u.id AND f2.following_id = %s)
            ORDER BY u.last_seen DESC
        """, (user_id, user_id, user_id))
        
        return jsonify([{"id": r[0], "username": r[1], "name": r[2], "profile_picture": r[3], "is_online": r[4]} for r in cur.fetchall()])
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_conversations", methods=["GET"])
@token_required
def get_conversations():
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify([]), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        update_last_seen(user_id)
        
        cur.execute("""
            SELECT CASE WHEN m.sender_id = %s THEN m.receiver_id ELSE m.sender_id END as other_user_id,
                   MAX(m.created_at) as last_message_time,
                   COUNT(CASE WHEN m.receiver_id = %s AND m.is_read = FALSE THEN 1 END) as unread_count
            FROM messages m
            WHERE m.sender_id = %s OR m.receiver_id = %s
            GROUP BY other_user_id
            ORDER BY last_message_time DESC
        """, (user_id, user_id, user_id, user_id))
        
        conversations = []
        for row in cur.fetchall():
            other_id, last_time, unread = row
            cur.execute("SELECT username, name, profile_picture FROM users WHERE id = %s", (other_id,))
            user = cur.fetchone()
            cur.execute("""
                SELECT content, sender_id FROM messages
                WHERE (sender_id = %s AND receiver_id = %s) OR (sender_id = %s AND receiver_id = %s)
                ORDER BY created_at DESC LIMIT 1
            """, (user_id, other_id, other_id, user_id))
            last_msg = cur.fetchone()
            
            if user:
                conversations.append({
                    "user_id": other_id,
                    "username": user[0],
                    "name": user[1],
                    "profile_picture": user[2],
                    "last_message_time": str(last_time),
                    "last_message": last_msg[0] if last_msg else "",
                    "last_message_from_me": last_msg[1] == user_id if last_msg else False,
                    "unread_count": unread
                })
        return jsonify(conversations)
    finally:
        cur.close()
        release_conn(conn)

@app.route("/get_messages/<string:other_username>", methods=["GET"])
@token_required
def get_messages(other_username):
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        update_last_seen(user_id)
        
        cur.execute("SELECT id, profile_picture FROM users WHERE username = %s", (other_username,))
        other_user = cur.fetchone()
        if not other_user:
            return jsonify({"msg": "user_not_found"}), 404
        other_id, other_pic = other_user
        
        cur.execute("UPDATE messages SET is_read = TRUE WHERE sender_id = %s AND receiver_id = %s AND is_read = FALSE", (other_id, user_id))
        conn.commit()
        
        cur.execute("""
            SELECT m.id, m.content, m.created_at, m.sender_id, m.reply_to_id,
                   u.username, u.profile_picture,
                   r.id as reply_id, r.content as reply_content, r.sender_id as reply_sender_id,
                   ru.username as reply_username
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            LEFT JOIN messages r ON m.reply_to_id = r.id
            LEFT JOIN users ru ON r.sender_id = ru.id
            WHERE (m.sender_id = %s AND m.receiver_id = %s) OR (m.sender_id = %s AND m.receiver_id = %s)
            ORDER BY m.created_at ASC
            LIMIT 100
        """, (user_id, other_id, other_id, user_id))
        
        messages = []
        for row in cur.fetchall():
            msg_id = row[0]
            cur.execute("SELECT emoji, user_id FROM message_reactions WHERE message_id = %s", (msg_id,))
            all_reactions = cur.fetchall()
            reaction_counts = {}
            for emoji, uid in all_reactions:
                reaction_counts[emoji] = reaction_counts.get(emoji, 0) + 1
            user_reactions = [emoji for emoji, uid in all_reactions if uid == user_id]
            
            messages.append({
                "id": msg_id,
                "content": row[1],
                "created_at": str(row[2]),
                "sender_id": row[3],
                "reply_to_id": row[4],
                "sender_username": row[5],
                "sender_picture": row[6],
                "is_mine": row[3] == user_id,
                "reply_context": {"id": row[7], "content": row[8], "sender_id": row[9], "sender_username": row[10]} if row[7] else None,
                "reactions": reaction_counts,
                "user_reactions": user_reactions
            })
        return jsonify({"messages": messages, "other_user_picture": other_pic})
    except Exception as e:
        conn.rollback()
        logger.error(f"Get messages error: {e}")
        return jsonify({"msg": "server_error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/send_message", methods=["POST"])
@token_required
def send_message():
    user_val = request.current_user_id
    receiver_username = request.json.get("receiver_username")
    content = request.json.get("content", "").strip()
    if not receiver_username or not content:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        sender_id = resolve_user_id(cur, user_val)
        if not sender_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT id FROM users WHERE username = %s", (receiver_username,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "user_not_found"}), 404
        receiver_id = row[0]
        
        reply_to_id = request.json.get("reply_to_id")
        cur.execute("INSERT INTO messages (sender_id, receiver_id, content, reply_to_id) VALUES (%s, %s, %s, %s)",
                   (sender_id, receiver_id, content, reply_to_id))
        conn.commit()
        return jsonify({"msg": "sent"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Send message error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/delete_message/<int:message_id>", methods=["DELETE"])
@token_required
def delete_message(message_id):
    user_val = request.current_user_id
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        sender_id = resolve_user_id(cur, user_val)
        if not sender_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT sender_id FROM messages WHERE id = %s", (message_id,))
        row = cur.fetchone()
        if not row or row[0] != sender_id:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("DELETE FROM messages WHERE id = %s", (message_id,))
        conn.commit()
        return jsonify({"msg": "deleted"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Delete message error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/add_reaction", methods=["POST"])
@token_required
def add_reaction():
    user_val = request.current_user_id
    message_id = request.json.get("message_id")
    emoji = request.json.get("emoji")
    if not message_id or not emoji:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("SELECT sender_id FROM messages WHERE id = %s", (message_id,))
        msg_row = cur.fetchone()
        if msg_row and msg_row[0] == user_id:
            return jsonify({"msg": "cannot_react_own_message"}), 400
        
        cur.execute("INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (%s, %s, %s)",
                   (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_added"})
    except psycopg2.IntegrityError:
        conn.rollback()
        return jsonify({"msg": "already_reacted"}), 409
    except Exception as e:
        conn.rollback()
        logger.error(f"Add reaction error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/remove_reaction", methods=["POST"])
@token_required
def remove_reaction():
    user_val = request.current_user_id
    message_id = request.json.get("message_id")
    emoji = request.json.get("emoji")
    if not message_id or not emoji:
        return jsonify({"msg": "missing_fields"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        user_id = resolve_user_id(cur, user_val)
        if not user_id:
            return jsonify({"msg": "user_not_found"}), 404
        
        cur.execute("DELETE FROM message_reactions WHERE message_id = %s AND user_id = %s AND emoji = %s",
                   (message_id, user_id, emoji))
        conn.commit()
        return jsonify({"msg": "reaction_removed"})
    except Exception as e:
        conn.rollback()
        logger.error(f"Remove reaction error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

@app.route("/edit_message/<int:message_id>", methods=["PUT"])
@token_required
def edit_message(message_id):
    user_val = request.current_user_id
    new_content = request.json.get("content", "").strip()
    if not new_content:
        return jsonify({"msg": "empty_content"}), 400
    
    conn = get_conn()
    if not conn:
        return jsonify({"msg": "db_error"}), 503
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT sender_id FROM messages WHERE id = %s", (message_id,))
        row = cur.fetchone()
        if not row:
            return jsonify({"msg": "not_found"}), 404
        
        user_id = resolve_user_id(cur, user_val)
        if not user_id or user_id != row[0]:
            return jsonify({"msg": "unauthorized"}), 403
        
        cur.execute("UPDATE messages SET content = %s WHERE id = %s", (new_content, message_id))
        conn.commit()
        return jsonify({"msg": "ok", "content": new_content})
    except Exception as e:
        conn.rollback()
        logger.error(f"Edit message error: {e}")
        return jsonify({"msg": "error"}), 500
    finally:
        cur.close()
        release_conn(conn)

# Initialize DB and tables
def init_db():
    conn = get_conn()
    if not conn:
        logger.error("❌ Cannot connect to DB for init")
        return
    cursor = conn.cursor()
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT,
                email TEXT UNIQUE,
                phone TEXT UNIQUE,
                username TEXT UNIQUE,
                password TEXT,
                profile_picture TEXT DEFAULT 'unknown',
                last_seen TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,
                image TEXT,
                video TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                like_count INT DEFAULT 0,
                comment_count INT DEFAULT 0,
                repost_count INT DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS likes (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, post_id)
            );
            CREATE TABLE IF NOT EXISTS follows (
                id SERIAL PRIMARY KEY,
                follower_id INT REFERENCES users(id) ON DELETE CASCADE,
                following_id INT REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(follower_id, following_id)
            );
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS reposts (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                post_id INT REFERENCES posts(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, post_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INT REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
                content TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                is_read BOOLEAN DEFAULT FALSE,
                reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS message_reactions (
                id SERIAL PRIMARY KEY,
                message_id INT REFERENCES messages(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                emoji TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id, user_id, emoji)
            );
            -- Indexes for performance
            CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
            CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);
            CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
            CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
            CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(sender_id, receiver_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        """)
        conn.commit()
        logger.info("✅ Database tables initialized")
    except Exception as e:
        conn.rollback()
        logger.error(f"❌ DB init error: {e}")
    finally:
        cursor.close()
        release_conn(conn)

if __name__ == "__main__":
    init_db_pool()
    init_db()
    # For local dev only - use Gunicorn in production
    app.run(debug=False, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
