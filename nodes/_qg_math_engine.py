# -*- coding: utf-8 -*-
"""安全表达式求值 —— 只走 ast 白名单，不碰 Python 的动态求值通道。

为什么不用内置的 eval：节点上的表达式来自工作流文件，和 LLM 输出、别人分享的
工作流一样属于**外部输入**。哪怕清空 __builtins__，属性链（``().__class__``）
照样能绕出去。这里改成「先解析成语法树，再按白名单逐节点算」：

    · 允许：数字、字符串、变量 a/b/c/d、常量 pi/e/tau、四则、整除、取余、幂、
            一元正负、比较（含 in）、and/or/not、三元表达式、列表、下标与切片、
            白名单函数调用
    · 拒绝：属性访问、lambda、推导式、赋值、f-string、星号展开、关键字参数，
            以及任何不在白名单里的名字或函数

值的形态只有两种：数字（内部一律 float）和文本（str）。``+`` 只要有一侧是文本
就是拼接，``*`` 一侧是文本一侧是数字就是重复 —— 跟 Python 一致，不搞隐式魔法。
变量接进来的字符串如果整串能解析成数字，会当数字用（``"1024"`` 直接参与算术），
否则当文本；想强制转换就写 ``float(a)`` / ``str(a)``。

算不出来时统一抛 MathError（ValueError 子类），由节点带着表达式原文转出去，
让 ComfyUI 的红框直接显示哪一段写错了。
"""

import ast
import math

# 表达式长度与节点数上限：防止有人贴一屏字符或写一串 10**10**10**10 把执行卡死。
MAX_LENGTH = 2000
MAX_NODES = 400
# 幂的指数上限；底数上限跟 MAX_ABS 一致。
MAX_EXPONENT = 512
MAX_ABS = 1e15
# 文本与列表的规模上限。拼接、重复、split 都可能指数级放大，
# 一个 "a" * 999999999 就能把节点的内存吃光，所以每一处出口都要卡。
MAX_TEXT = 10000
MAX_LIST = 1000

CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
    "inf": math.inf,
}

# 报错时把 ast 的运算符类翻成人话：红框里写「文本不能做 除法 运算」比
# 「不能做 Div 运算」好懂。
_OP_TEXT = {
    ast.Sub: "subtraction",
    ast.Div: "division",
    ast.FloorDiv: "floor division",
    ast.Mod: "modulo",
    ast.Pow: "power",
    ast.BitAnd: "bitwise and",
    ast.BitOr: "bitwise or",
    ast.BitXor: "bitwise xor",
    ast.LShift: "left shift",
    ast.RShift: "right shift",
}

# 全角 / 中文输入法打出来的运算符 → 半角。用户从聊天窗口、比例标注里粘进来的
# 字符串经常是全角的，先归一再解析，比让人猜为什么报错友好。
NORMALIZE = {
    "\uff08": "(",   # （
    "\uff09": ")",   # ）
    "\uff0b": "+",   # ＋
    "\uff0d": "-",   # －
    "\u2212": "-",   # −
    "\u00d7": "*",   # ×
    "\uff0a": "*",   # ＊
    "\u00f7": "/",   # ÷
    "\uff0f": "/",   # ／
    "\uff1a": "/",   # ：（比例写法 3：4）
    "\uff0e": ".",   # ．
    "\uff0c": ",",   # ，
}


class MathError(ValueError):
    """表达式写错了：语法、未知名字、越界、除零、参数不对……"""


def normalize(text):
    for src, dst in NORMALIZE.items():
        text = text.replace(src, dst)
    return text


def to_number(value):
    """把外部值（数字 / 数字字符串 / None）统一成 float；认不出来就是 0.0。"""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = normalize(str(value).strip())
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def to_value(value):
    """把上游接进来的值收敛成「数字或文本」，字符串不再被无条件压成 0。

    数字优先：整串能解析成数字的字符串（``"1024"``、``" 3.5 "``）当数字用，
    这样接一个填了尺寸的文本节点进来照样能算；其余原样当文本。
    """
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        value = str(value)
    if len(value) > MAX_TEXT:
        raise MathError("Text from the input is too long (limit %d characters)" % MAX_TEXT)
    # 只有「判断像不像数字」用归一化后的串，返回的仍是原文 ——
    # 归一化会把全角括号改成半角，拿它当文本内容会悄悄改字。
    stripped = value.strip()
    if not stripped:
        # 空白串当「没填」：和未连线一样按 0 算，免得 a + b 拼出 "0" 这种怪结果。
        return 0.0
    try:
        return float(normalize(stripped))
    except ValueError:
        return value


def format_number(value):
    """数字转文本：整数不带 .0，浮点压掉二进制噪声（0.1+0.2 → 0.3）。"""
    if isinstance(value, bool):
        return "True" if value else "False"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if not math.isfinite(number):
        # evaluate() 出口已经拦过，这里只是别让 format 出 "inf" 这种下游看不懂的串。
        raise MathError("The result is not a finite number, so it cannot be used as text")
    if number == int(number) and abs(number) < 1e16:
        return str(int(number))
    text = "%.10g" % number
    return text


def _text_of(value):
    """拼字符串时的取值：数字按人读的样子写（1024 而不是 1024.0）。"""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return format_number(value)
    if isinstance(value, list):
        return str(value)
    return str(value)


def _concat(left, right):
    a = _text_of(left)
    b = _text_of(right)
    if len(a) + len(b) > MAX_TEXT:
        raise MathError("The joined text is too long (limit %d characters)" % MAX_TEXT)
    return a + b


def _repeat(text, count):
    times = int(_number(count, "repetition"))
    if times <= 0:
        return ""
    if len(text) * times > MAX_TEXT:
        raise MathError("The repeated text is too long (limit %d characters)" % MAX_TEXT)
    return text * times


# ---------------------------------------------------------------- 白名单函数
#
# 每个包装都只管两件事：把参数收敛成数字、把 Python 自己的异常翻译成人话。
# 直接塞 math.sqrt 也行，但 sqrt(-1) 会抛 ValueError，报错信息里不带「哪个函数」，
# 用户看不出是表达式的问题还是节点的问题。

def _int(x):
    number = _number(x, "int")
    if abs(number) > MAX_ABS:
        raise MathError("int() value is too large (limit %g)" % MAX_ABS)
    return int(number)


def round_half_away(value):
    """四舍五入，正好 .5 时**远离零**：2.5 → 3、-2.5 → -3。

    Python 内置 ``round()`` 是银行家舍入（2.5 → 2、3.5 → 4），拿它当宽度
    会出现「2.5 的尺寸缩成 2」这种反直觉结果，偶数还系统性偏小。节点的
    「整数」输出和表达式里的 ``round()`` 都走这一条，两边口径一致。

    不用 ``floor(x + 0.5)``：``0.49999999999999994 + 0.5`` 会进到 1.0，
    那个经典浮点坑会把 0.4999… 舍成 1。
    """
    if not math.isfinite(value):
        # round(inf) 在 math.floor 里抛的是裸 OverflowError，红框会显示英文回溯。
        raise MathError("round() needs a finite number, got %r" % (value,))
    lower = math.floor(value)
    diff = value - lower
    if diff > 0.5:
        return int(lower + 1)
    if diff < 0.5:
        return int(lower)
    # 正好 .5：正数进位、负数退位，两个方向都是「远离零」。
    return int(lower + 1) if value > 0 else int(lower)


def _round(x, digits=None):
    number = _number(x, "round")
    if digits is None:
        return round_half_away(number)
    places = int(_number(digits, "round"))
    if not -15 <= places <= 15:
        raise MathError("round() digits must be between -15 and 15")
    factor = 10.0 ** places
    return round_half_away(number * factor) / factor


def _factorial(x):
    number = int(_number(x, "factorial"))
    # 170! ≈ 7.3e306 是 double 装得下的最后一个阶乘，171! 就溢出了。上限原本
    # 写到 300，可节点输出是 float：171 以上会在节点层的 float(result) 里抛
    # 裸 OverflowError，红框里是英文回溯而不是这里设计的提示。
    if not 0 <= number <= 170:
        raise MathError("factorial() only accepts integers from 0 to 170 (larger factorials exceed double precision)")
    return math.factorial(number)


def _gcd(x, y):
    return math.gcd(int(_number(x, "gcd")), int(_number(y, "gcd")))


def _lcm(x, y):
    a = int(_number(x, "lcm"))
    b = int(_number(y, "lcm"))
    if not a or not b:
        return 0
    return abs(a * b) // math.gcd(a, b)


def _number(value, name="argument"):
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        raise MathError("%s() only accepts numbers, got %r" % (name, value))


def _sign(x):
    number = _number(x, "sign")
    if number == 0:
        return 0
    return 1 if number > 0 else -1


def _pow(base, exponent):
    b = _number(base, "pow")
    e = _number(exponent, "pow")
    if abs(e) > MAX_EXPONENT:
        raise MathError("Exponent is too large (limit %d)" % MAX_EXPONENT)
    if abs(b) > MAX_ABS:
        raise MathError("Base is too large (limit %g)" % MAX_ABS)
    try:
        return b ** e
    except ZeroDivisionError:
        raise MathError("Zero cannot be raised to a negative power")
    except OverflowError:
        raise MathError("Power operation overflowed")


def _guard(name, function):
    """包一层：把 ValueError / TypeError / OverflowError / ZeroDivisionError 统一成 MathError。"""
    def call(*args):
        try:
            return function(*args)
        except MathError:
            raise
        except ZeroDivisionError:
            raise MathError("%s(): division by zero" % name)
        except (ValueError, TypeError, OverflowError) as exc:
            raise MathError("%s() failed: %s" % (name, exc))
    return call


_SAFE_MATH = [
    "sqrt", "exp", "log", "log2", "log10", "sin", "cos", "tan",
    "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
    "asinh", "acosh", "atanh", "degrees", "radians", "hypot", "fabs",
    "fmod", "trunc", "floor", "ceil", "copysign", "dist", "prod", "fsum",
    "isnan", "isinf", "isfinite",
]

FUNCTIONS = {name: _guard(name, getattr(math, name)) for name in _SAFE_MATH}
FUNCTIONS.update({
    "abs": abs,
    "round": _round,
    "min": min,
    "max": max,
    "sum": sum,
    "pow": _pow,
    "int": _int,
    "float": lambda x: _number(x, "float"),
    "bool": lambda x: bool(x),
    "factorial": _factorial,
    "gcd": _gcd,
    "lcm": _lcm,
    "sign": _sign,
})


# ---------------------------------------------------------------- 文本函数
#
# Python 的字符串方法是 obj.method() 形式，但本引擎拒绝属性访问（属性链是
# 逃逸 __builtins__ 的经典入口）。所以文本操作一律做成「函数形式」：
# upper(s) 而不是 s.upper()，join(sep, items) 而不是 sep.join(items)。

def _arg_text(value, name):
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return format_number(value)
    raise MathError("%s() only accepts text, got %r" % (name, value))


def _len(value):
    if isinstance(value, (str, list)):
        return len(value)
    raise MathError("len() only accepts text or a list, got %r" % (value,))


def _str(value):
    return _text_of(value)


def _replace(text, old, new):
    source = _arg_text(text, "replace")
    result = source.replace(_arg_text(old, "replace"), _arg_text(new, "replace"))
    if len(result) > MAX_TEXT:
        raise MathError("replace() result is too long (limit %d characters)" % MAX_TEXT)
    return result


def _split(text, sep=None):
    source = _arg_text(text, "split")
    if sep is None or _arg_text(sep, "split") == "":
        parts = source.split()
    else:
        parts = source.split(_arg_text(sep, "split"))
    if len(parts) > MAX_LIST:
        raise MathError("split() produced too many items (limit %d)" % MAX_LIST)
    return parts


def _join(sep, items):
    if not isinstance(items, list):
        raise MathError("join(separator, list) needs the second argument written as […]")
    if len(items) > MAX_LIST:
        raise MathError("join() list is too long (limit %d items)" % MAX_LIST)
    separator = _arg_text(sep, "join")
    total = 0
    parts = []
    for item in items:
        piece = _text_of(item)
        total += len(piece) + len(separator)
        if total > MAX_TEXT:
            raise MathError("join() result is too long (limit %d characters)" % MAX_TEXT)
        parts.append(piece)
    return separator.join(parts)


def _zfill(text, width):
    source = _arg_text(text, "zfill")
    size = int(_number(width, "zfill"))
    if not 0 <= size <= MAX_TEXT:
        raise MathError("zfill() width must be between 0 and %d" % MAX_TEXT)
    return source.zfill(size)


FUNCTIONS.update({
    "str": _str,
    "len": _len,
    "upper": lambda s: _arg_text(s, "upper").upper(),
    "lower": lambda s: _arg_text(s, "lower").lower(),
    "title": lambda s: _arg_text(s, "title").title(),
    "capitalize": lambda s: _arg_text(s, "capitalize").capitalize(),
    "swapcase": lambda s: _arg_text(s, "swapcase").swapcase(),
    "strip": lambda s: _arg_text(s, "strip").strip(),
    "lstrip": lambda s: _arg_text(s, "lstrip").lstrip(),
    "rstrip": lambda s: _arg_text(s, "rstrip").rstrip(),
    "replace": _replace,
    "split": _split,
    "join": _join,
    "find": lambda s, sub: _arg_text(s, "find").find(_arg_text(sub, "find")),
    "rfind": lambda s, sub: _arg_text(s, "rfind").rfind(_arg_text(sub, "rfind")),
    "count": lambda s, sub: _arg_text(s, "count").count(_arg_text(sub, "count")),
    "startswith": lambda s, p: _arg_text(s, "startswith").startswith(_arg_text(p, "startswith")),
    "endswith": lambda s, p: _arg_text(s, "endswith").endswith(_arg_text(p, "endswith")),
    "zfill": _zfill,
})


# ---------------------------------------------------------------- 求值

def _eval(node, scope):
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, str):
            if len(value) > MAX_TEXT:
                raise MathError("Text in the expression is too long (limit %d characters)" % MAX_TEXT)
            return value
        if isinstance(value, (int, float)):
            return value
        raise MathError("Unsupported constant in the expression: %r" % (value,))

    if isinstance(node, ast.Name):
        if node.id in scope:
            return scope[node.id]
        # 变量名大小写不敏感：上游写 A、表达式写 a 都通。
        lowered = node.id.lower()
        if lowered in scope:
            return scope[lowered]
        raise MathError("Unknown name \"%s\"; available: %s"
                        % (node.id, ", ".join(sorted(scope))))

    if isinstance(node, ast.UnaryOp):
        value = _eval(node.operand, scope)
        if isinstance(node.op, ast.UAdd):
            return +_number(value)
        if isinstance(node.op, ast.USub):
            return -_number(value)
        if isinstance(node.op, ast.Not):
            return not value
        if isinstance(node.op, ast.Invert):
            return ~int(_number(value))
        raise MathError("Unsupported unary operation")

    if isinstance(node, ast.BinOp):
        left = _eval(node.left, scope)
        right = _eval(node.right, scope)
        op = node.op
        if isinstance(op, ast.Add):
            if isinstance(left, str) or isinstance(right, str):
                return _concat(left, right)
            return _number(left) + _number(right)
        if isinstance(op, ast.Mult):
            if isinstance(left, str):
                return _repeat(left, right)
            if isinstance(right, str):
                return _repeat(right, left)
            return _number(left) * _number(right)
        # 其余算术只对数字成立：给一句人话，别让 float("abc") 的英文异常漏出去。
        if isinstance(left, str) or isinstance(right, str):
            raise MathError(
                "Text cannot be used with %s (%r and %r): convert it to a number with float() or int() first"
                % (_OP_TEXT.get(type(op), "this operation"), left, right)
            )
        if isinstance(op, ast.Sub):
            return _number(left) - _number(right)
        if isinstance(op, (ast.Div, ast.FloorDiv, ast.Mod)):
            divisor = _number(right)
            if divisor == 0:
                raise MathError("Division by zero")
            dividend = _number(left)
            if isinstance(op, ast.Div):
                return dividend / divisor
            if isinstance(op, ast.FloorDiv):
                return dividend // divisor
            return dividend % divisor
        if isinstance(op, ast.Pow):
            return _pow(left, right)
        if isinstance(op, ast.BitAnd):
            return int(_number(left)) & int(_number(right))
        if isinstance(op, ast.BitOr):
            return int(_number(left)) | int(_number(right))
        if isinstance(op, ast.BitXor):
            return int(_number(left)) ^ int(_number(right))
        if isinstance(op, ast.LShift):
            return int(_number(left)) << min(32, max(0, int(_number(right))))
        if isinstance(op, ast.RShift):
            return int(_number(left)) >> min(64, max(0, int(_number(right))))
        raise MathError("Unsupported operator")

    if isinstance(node, ast.BoolOp):
        values = [_eval(item, scope) for item in node.values]
        if isinstance(node.op, ast.And):
            result = values[0]
            for item in values[1:]:
                if not result:
                    return result
                result = item
            return result
        result = values[0]
        for item in values[1:]:
            if result:
                return result
            result = item
        return result

    if isinstance(node, ast.Compare):
        left = _eval(node.left, scope)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval(comparator, scope)
            if isinstance(op, ast.Eq):
                ok = left == right
            elif isinstance(op, ast.NotEq):
                ok = left != right
            elif isinstance(op, (ast.In, ast.NotIn)):
                if not isinstance(right, (str, list)):
                    raise MathError("The right side of 'in' must be text or a list, got %r" % (right,))
                if isinstance(right, str) and not isinstance(left, str):
                    # `5 in "abc"` 在 Python 里抛 TypeError，那会一路穿到红框。
                    raise MathError("When the right side is text, the left side must be text too, got %r" % (left,))
                ok = left in right
                if isinstance(op, ast.NotIn):
                    ok = not ok
            elif isinstance(op, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
                # 两侧都是文本时按字符串比（"apple" < "banana"），否则按数值比。
                if isinstance(left, str) and isinstance(right, str):
                    first, second = left, right
                else:
                    first, second = _number(left), _number(right)
                ok = {
                    ast.Lt: first < second,
                    ast.LtE: first <= second,
                    ast.Gt: first > second,
                    ast.GtE: first >= second,
                }[type(op)]
            else:
                raise MathError("Unsupported comparison")
            if not ok:
                return False
            left = right
        return True

    if isinstance(node, ast.IfExp):
        return _eval(node.body, scope) if _eval(node.test, scope) else _eval(node.orelse, scope)

    if isinstance(node, (ast.List, ast.Tuple)):
        if len(node.elts) > MAX_LIST:
            raise MathError("List is too long (limit %d items)" % MAX_LIST)
        return [_eval(item, scope) for item in node.elts]

    if isinstance(node, ast.Subscript):
        target = _eval(node.value, scope)
        if not isinstance(target, (str, list)):
            raise MathError("Only text and lists support indexing ([ ]), got %r" % (target,))
        part = node.slice
        if isinstance(part, ast.Slice):
            bounds = []
            for piece in (part.lower, part.upper, part.step):
                bounds.append(None if piece is None
                              else int(_number(_eval(piece, scope), "index")))
            try:
                return target[slice(bounds[0], bounds[1], bounds[2])]
            except ValueError:
                raise MathError("Slice step cannot be 0")
        position = int(_number(_eval(part, scope), "index"))
        try:
            return target[position]
        except IndexError:
            raise MathError("Index out of range: only %d items, cannot take item %d"
                            % (len(target), position))

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise MathError("Only whitelisted functions can be called directly; a.b() is not supported")
        name = node.func.id
        function = FUNCTIONS.get(name)
        if function is None:
            raise MathError("No function named \"%s\"; available: %s"
                            % (name, ", ".join(sorted(FUNCTIONS))))
        if node.keywords:
            raise MathError("%s() does not accept keyword arguments" % name)
        args = []
        for arg in node.args:
            if isinstance(arg, ast.Starred):
                raise MathError("%s() does not accept * unpacking" % name)
            args.append(_eval(arg, scope))
        try:
            return function(*args)
        except MathError:
            raise
        except TypeError as exc:
            raise MathError("%s() got invalid arguments: %s" % (name, exc))
        except ZeroDivisionError:
            raise MathError("%s(): division by zero" % name)

    if isinstance(node, ast.Attribute):
        raise MathError("Attribute access is not supported (%s....); call functions by name" % getattr(node.value, "id", "?"))

    raise MathError("Unsupported construct in the expression: %s" % type(node).__name__)


def variables_of(**values):
    """把节点收到的 a/b/c… 收敛成求值作用域；None 当 0，能当数字的字符串当数字。"""
    return {name: to_value(value) for name, value in values.items()}


def evaluate(expression, variables=None):
    """算一个表达式，返回 Python 数字（int / float / bool）或文本（str）。空表达式返回 0.0。"""
    text = normalize("" if expression is None else str(expression)).strip()
    if not text:
        return 0.0
    if len(text) > MAX_LENGTH:
        raise MathError("Expression is too long (limit %d characters)" % MAX_LENGTH)
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        where = ("near character %s" % exc.offset) if exc.offset else "somewhere"
        raise MathError("Syntax error (%s): %s" % (where, exc.msg))
    if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
        raise MathError("Expression is too complex (limit %d syntax nodes)" % MAX_NODES)
    scope = dict(CONSTANTS)
    scope.update(variables or {})
    result = _eval(tree.body, scope)
    if isinstance(result, str):
        if len(result) > MAX_TEXT:
            raise MathError("The resulting text is too long (limit %d characters)" % MAX_TEXT)
        return result
    # 出口统一拦一次：inf / nan 一律当错误。以前只兜了 NaN（静默收成 0），
    # inf 会漏到节点层变成 `int(round(inf))` 的裸 OverflowError，红框里是
    # 一句英文，跟其它中文报错对不上。这里拦掉，报错信息才说得清。
    if isinstance(result, float) and not math.isfinite(result):
        raise MathError(
            "The result is not a finite number (%s): check for a literal inf, or an intermediate overflow"
            % ("infinity" if math.isinf(result) else "NaN")
        )
    return result
