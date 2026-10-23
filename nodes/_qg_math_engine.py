# -*- coding: utf-8 -*-
"""安全表达式求值 —— 只走 ast 白名单，不碰 Python 的动态求值通道。

为什么不用内置的 eval：节点上的表达式来自工作流文件，和 LLM 输出、别人分享的
工作流一样属于**外部输入**。哪怕清空 __builtins__，属性链（``().__class__``）
照样能绕出去。这里改成「先解析成语法树，再按白名单逐节点算」：

    · 允许：数字、变量 a/b/c/d、常量 pi/e/tau、四则、整除、取余、幂、
            一元正负、比较、and/or/not、三元表达式、列表、白名单函数调用
    · 拒绝：属性访问、下标、lambda、推导式、赋值、f-string、星号展开、
            关键字参数，以及任何不在白名单里的名字或函数

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

CONSTANTS = {
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
    "inf": math.inf,
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


# ---------------------------------------------------------------- 白名单函数
#
# 每个包装都只管两件事：把参数收敛成数字、把 Python 自己的异常翻译成人话。
# 直接塞 math.sqrt 也行，但 sqrt(-1) 会抛 ValueError，报错信息里不带「哪个函数」，
# 用户看不出是表达式的问题还是节点的问题。

def _int(x):
    number = _number(x, "int")
    if abs(number) > MAX_ABS:
        raise MathError("int() 的值太大（上限 %g）" % MAX_ABS)
    return int(number)


def _round(x, digits=None):
    number = _number(x, "round")
    if digits is None:
        return round(number)
    places = int(_number(digits, "round"))
    if not -15 <= places <= 15:
        raise MathError("round() 的小数位要在 -15 到 15 之间")
    return round(number, places)


def _factorial(x):
    number = int(_number(x, "factorial"))
    if not 0 <= number <= 300:
        raise MathError("factorial() 只接受 0 到 300 的整数")
    return math.factorial(number)


def _gcd(x, y):
    return math.gcd(int(_number(x, "gcd")), int(_number(y, "gcd")))


def _lcm(x, y):
    a = int(_number(x, "lcm"))
    b = int(_number(y, "lcm"))
    if not a or not b:
        return 0
    return abs(a * b) // math.gcd(a, b)


def _number(value, name="参数"):
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        raise MathError("%s() 只接受数字，收到 %r" % (name, value))


def _sign(x):
    number = _number(x, "sign")
    if number == 0:
        return 0
    return 1 if number > 0 else -1


def _pow(base, exponent):
    b = _number(base, "pow")
    e = _number(exponent, "pow")
    if abs(e) > MAX_EXPONENT:
        raise MathError("指数太大（上限 %d）" % MAX_EXPONENT)
    if abs(b) > MAX_ABS:
        raise MathError("底数太大（上限 %g）" % MAX_ABS)
    try:
        return b ** e
    except ZeroDivisionError:
        raise MathError("0 不能取负数次幂")
    except OverflowError:
        raise MathError("幂运算结果溢出")


def _guard(name, function):
    """包一层：把 ValueError / TypeError / OverflowError / ZeroDivisionError 统一成 MathError。"""
    def call(*args):
        try:
            return function(*args)
        except MathError:
            raise
        except ZeroDivisionError:
            raise MathError("%s() 里出现了除以零" % name)
        except (ValueError, TypeError, OverflowError) as exc:
            raise MathError("%s() 算不了：%s" % (name, exc))
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
    "bool": lambda x: bool(_number(x, "bool")),
    "factorial": _factorial,
    "gcd": _gcd,
    "lcm": _lcm,
    "sign": _sign,
})


# ---------------------------------------------------------------- 求值

def _eval(node, scope):
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, (int, float)):
            return value
        raise MathError("表达式里出现了不支持的常量 %r" % (value,))

    if isinstance(node, ast.Name):
        if node.id in scope:
            return scope[node.id]
        # 变量名大小写不敏感：上游写 A、表达式写 a 都通。
        lowered = node.id.lower()
        if lowered in scope:
            return scope[lowered]
        raise MathError("不认识的名字「%s」，能用的是 %s"
                        % (node.id, "、".join(sorted(scope))))

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
        raise MathError("不支持的一元运算")

    if isinstance(node, ast.BinOp):
        left = _eval(node.left, scope)
        right = _eval(node.right, scope)
        op = node.op
        if isinstance(op, ast.Add):
            return _number(left) + _number(right)
        if isinstance(op, ast.Sub):
            return _number(left) - _number(right)
        if isinstance(op, ast.Mult):
            return _number(left) * _number(right)
        if isinstance(op, (ast.Div, ast.FloorDiv, ast.Mod)):
            divisor = _number(right)
            if divisor == 0:
                raise MathError("除数是 0")
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
        raise MathError("不支持的运算符")

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
            elif isinstance(op, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
                first, second = _number(left), _number(right)
                ok = {
                    ast.Lt: first < second,
                    ast.LtE: first <= second,
                    ast.Gt: first > second,
                    ast.GtE: first >= second,
                }[type(op)]
            else:
                raise MathError("不支持的比较运算")
            if not ok:
                return False
            left = right
        return True

    if isinstance(node, ast.IfExp):
        return _eval(node.body, scope) if _eval(node.test, scope) else _eval(node.orelse, scope)

    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval(item, scope) for item in node.elts]

    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise MathError("只能直接调用白名单里的函数，不支持 a.b() 这种写法")
        name = node.func.id
        function = FUNCTIONS.get(name)
        if function is None:
            raise MathError("没有叫「%s」的函数，能用的是 %s"
                            % (name, "、".join(sorted(FUNCTIONS))))
        if node.keywords:
            raise MathError("%s() 不支持关键字参数" % name)
        args = []
        for arg in node.args:
            if isinstance(arg, ast.Starred):
                raise MathError("%s() 不支持 *展开" % name)
            args.append(_eval(arg, scope))
        try:
            return function(*args)
        except MathError:
            raise
        except TypeError as exc:
            raise MathError("%s() 参数不对：%s" % (name, exc))
        except ZeroDivisionError:
            raise MathError("%s() 里出现了除以零" % name)

    if isinstance(node, ast.Attribute):
        raise MathError("不支持属性访问（%s.…），函数请直接写名字" % getattr(node.value, "id", "?"))

    raise MathError("表达式里有不支持的写法：%s" % type(node).__name__)


def variables_of(**values):
    """把节点收到的 a/b/c/d 收敛成求值作用域；None 当 0。"""
    return {name: to_number(value) for name, value in values.items()}


def evaluate(expression, variables=None):
    """算一个表达式，返回 Python 数字（int / float / bool）。空表达式返回 0.0。"""
    text = normalize("" if expression is None else str(expression)).strip()
    if not text:
        return 0.0
    if len(text) > MAX_LENGTH:
        raise MathError("表达式太长了（上限 %d 个字符）" % MAX_LENGTH)
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as exc:
        where = ("第 %s 个字符附近" % exc.offset) if exc.offset else "某个位置"
        raise MathError("语法错误（%s）：%s" % (where, exc.msg))
    if sum(1 for _ in ast.walk(tree)) > MAX_NODES:
        raise MathError("表达式太复杂了（上限 %d 个语法节点）" % MAX_NODES)
    scope = dict(CONSTANTS)
    scope.update(variables or {})
    return _eval(tree.body, scope)
