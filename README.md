# ProductsManagment

מערכת REST פשוטה ב-Node.js + Express + PostgreSQL לניהול **קטגוריות**, **פריטים**, ו-**Volumes** עם **מחירים** לכל שילוב פריט×Volume.

- שם פריט ייחודי  
- כל פריט שייך לקטגוריה  
- לכל פריט לפחות Volume אחד  
- מחיר Volume ייחודי לכל פריט (`UNIQUE(item_id, price)`)  
- חיפוש על שם פריט, שם קטגוריה, וערך Volume  
- כל ה־endpoints מוגנים ב־API Key  

---

## תוכן עניינים
- [התקנה והרצה](#התקנה-והרצה)
- [אבטחה](#אבטחה)
- [Endpoints](#endpoints)



## התקנה והרצה
1) התקנת תלויות:
npm i



2) הרצת השרת:
npm start




## אבטחה
כל ה־endpoints מוגנים עם API Key דרך Header:
x-api-key: 



---

## Endpoints
1) **POST `/category`** – יצירת קטגוריה (Idempotent)  
   **Headers:** `x-api-key`, `Content-Type: application/json`  
   **Body:**
{ "name": "Fitness" }



2) **POST `/items`** – יצירה/עדכון פריט + Volumes (מחירים שונים לאותו item)  
**Headers:** `x-api-key`, `Content-Type: application/json`  
**Body:**
{
"name": "Pilates",
"price": 70.00,
"categoryId": 1,
"volumes": [
{ "value": "כניסות 10", "price": 70.00 },
{ "value": "חודשים 2", "price": 120.00 }
]
}


3) **GET `/items`** – רשימת כל הפריטים  
**Headers:** `x-api-key`

4) **GET `/item/:id`** – פריט יחיד עם ה־Volumes והמחירים שלו  
**Headers:** `x-api-key`  
**דוגמה:** `/item/1`

5) **GET `/category/:id`** – קטגוריה וכל הפריטים שלה (כולל Volumes)  
**Headers:** `x-api-key`  
**דוגמה:** `/category/1`

6) **GET `/item/search?q=...`** – חיפוש לפי שם פריט/קטגוריה/Volume  
**Headers:** `x-api-key`  
**דוגמאות:** `?q=Pilates`, `?q=כניסות`
